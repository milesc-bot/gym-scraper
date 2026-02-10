/**
 * humanBehavior.ts — Human-like browser interactions via ghost-cursor.
 *
 * WHY wrap ghost-cursor instead of using it directly?
 * ───────────────────────────────────────────────────
 * 1. **Unified API:**  The rest of the codebase calls `humanClick()` and
 *    `humanScroll()` without knowing about ghost-cursor internals.  If we
 *    ever swap the underlying library, only this file changes.
 * 2. **Extended coverage:**  ghost-cursor handles mouse movement and clicks
 *    (with Bezier curves, overshoot, Fitts's Law) but does NOT cover
 *    scrolling or typing.  We add custom implementations for those here.
 * 3. **Integration surface:**  Other modules (stealthFetcher, sessionManager)
 *    import from one place rather than juggling ghost-cursor + custom code.
 *
 * ghost-cursor features we get for free:
 *   • Bezier curve paths with 3-5 random control points
 *   • Overshoot-and-correct behaviour (real humans miss small targets)
 *   • Fitts's Law timing (big targets = fast, small targets = slow)
 *   • Stateful cursor position across interactions
 *   • Stochastic jitter at each interpolation step
 */

import { createCursor, GhostCursor } from 'ghost-cursor';
import type { Page } from 'puppeteer';
import { Logger } from '../core/logger';

const logger = new Logger('HumanBehavior');

// ─── Cursor management ─────────────────────────────────────

/**
 * Create a ghost-cursor instance bound to a Page.
 *
 * WHY return the raw GhostCursor?
 * Callers that need fine-grained control (e.g. the Login Agent typing
 * credentials) can use the full cursor API.  The helper functions below
 * are convenience wrappers for the common cases.
 */
export function createHumanCursor(page: Page): GhostCursor {
  return createCursor(page);
}

// ─── Mouse helpers ──────────────────────────────────────────

/**
 * Move the cursor to an element and click it with human-like motion.
 *
 * ghost-cursor handles:
 *   • Bezier path from current position to target
 *   • Overshoot + correction if target is small
 *   • Random click delay (50–150 ms hold time)
 */
export async function humanClick(
  cursor: GhostCursor,
  selector: string,
): Promise<void> {
  logger.info(`Human-clicking: ${selector}`);
  // WHY a random pause before clicking?
  // Real users pause briefly after the cursor reaches the target
  // (perceptual verification) before committing the click.
  await sleep(randomBetween(50, 150));
  await cursor.click(selector);
}

/**
 * Move the cursor to an element without clicking (hover).
 */
export async function humanMove(
  cursor: GhostCursor,
  selector: string,
): Promise<void> {
  await cursor.move(selector);
}

// ─── Scroll helper ──────────────────────────────────────────

/**
 * Scroll the page with variable-speed increments and micro-pauses.
 *
 * WHY not `page.evaluate(() => window.scrollBy(0, distance))`?
 * Instant jumps are trivially detectable.  Real mousewheel scrolling
 * has inertia: it starts slow, accelerates, then decelerates.  We
 * simulate this with a series of small `mouse.wheel()` calls with
 * randomised deltas and pauses.
 */
export async function humanScroll(
  page: Page,
  distance: number,
): Promise<void> {
  logger.info(`Human-scrolling ${distance}px…`);

  const direction = distance > 0 ? 1 : -1;
  let remaining = Math.abs(distance);

  // Simulate inertia: start with small deltas, grow, then shrink.
  while (remaining > 0) {
    // Delta follows a rough bell curve: larger in the middle of the
    // scroll, smaller at the start and end.
    const progress = 1 - remaining / Math.abs(distance);
    const bellFactor = Math.sin(progress * Math.PI); // 0→1→0
    const baseDelta = 20 + bellFactor * 80;           // 20–100 px
    const jitter = (Math.random() - 0.5) * 10;       // ±5 px noise
    const delta = Math.min(remaining, Math.max(5, baseDelta + jitter));

    await page.mouse.wheel({ deltaY: delta * direction });
    remaining -= delta;

    // Micro-pause between scroll events (30–80 ms).
    await sleep(randomBetween(30, 80));
  }
}

// ─── Typing helper ──────────────────────────────────────────

/**
 * Type text character-by-character with human-like inter-key timing.
 *
 * WHY not `page.type(selector, text)`?
 * Puppeteer's built-in `type()` uses a fixed delay between characters.
 * Real typing follows a normal distribution with occasional longer
 * "thinking" pauses (e.g., before a capital letter or after a space).
 */
export async function humanType(
  page: Page,
  selector: string,
  text: string,
): Promise<void> {
  logger.info(`Human-typing ${text.length} characters…`);

  // Focus the field first.
  await page.click(selector);
  await sleep(randomBetween(100, 300));

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    // Type the character.
    await page.keyboard.type(char);

    // Inter-key delay — normally distributed around 80 ms.
    let delay = gaussianRandom(80, 30);

    // Occasional "thinking" pause after spaces or before capitals.
    if (char === ' ' || (i + 1 < text.length && text[i + 1] === text[i + 1].toUpperCase() && /[A-Z]/.test(text[i + 1]))) {
      delay += randomBetween(100, 400);
    }

    // Clamp to reasonable range.
    delay = Math.max(20, Math.min(delay, 500));
    await sleep(delay);
  }
}

// ─── Idle simulation ────────────────────────────────────────

/**
 * Simulate a human reading the page: small cursor drifts, brief pauses,
 * and an optional gentle scroll.
 *
 * WHY bother with idle behaviour?
 * Modern WAFs correlate mouse telemetry with page load events.  A page
 * that loads and immediately extracts HTML with zero mouse/scroll activity
 * has a "bot signature" of 0.0.  Even a few seconds of idle movement
 * raises the humanity score above the blocking threshold.
 */
export async function randomIdle(
  page: Page,
  cursor: GhostCursor,
): Promise<void> {
  logger.info('Simulating human idle behaviour…');

  // 1. Small random cursor drift (2–4 movements).
  const driftCount = randomBetween(2, 4);
  for (let i = 0; i < driftCount; i++) {
    const viewport = page.viewport();
    const x = randomBetween(100, (viewport?.width ?? 1366) - 100);
    const y = randomBetween(100, (viewport?.height ?? 768) - 100);
    await cursor.moveTo({ x, y });
    await sleep(randomBetween(200, 800));
  }

  // 2. Optional gentle scroll (50% chance).
  if (Math.random() > 0.5) {
    await humanScroll(page, randomBetween(100, 400));
    await sleep(randomBetween(300, 600));
  }

  // 3. Final pause — simulates reading.
  await sleep(randomBetween(500, 1500));
}

// ─── Utility functions ──────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Box-Muller transform: generate a normally distributed random number.
 *
 * WHY Gaussian?
 * Real inter-key timing follows a normal distribution — most keystrokes
 * are near the mean, with occasional fast bursts and slow pauses.  A
 * uniform distribution looks unnatural.
 */
function gaussianRandom(mean: number, stdDev: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return z * stdDev + mean;
}
