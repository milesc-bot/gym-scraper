/**
 * extractionValidator.ts — Proof-by-Validation: "Trust but Verify" loop.
 *
 * WHY validate after extraction?
 * ──────────────────────────────
 * The current pipeline assumes extraction succeeded if no error was thrown.
 * But several failure modes produce *silent* bad data:
 *   1. The site returned a CAPTCHA page — Cheerio parses it as HTML, finds
 *      zero classes, and silently upserts nothing.
 *   2. The schedule shows only Monday but the full week exists behind a
 *      "Next Day" button — we scraped 1/7 of the data.
 *   3. The page rendered a loading skeleton — extracted class names are
 *      "Loading…" or CSS class names instead of real titles.
 *   4. JavaScript didn't finish executing — the light fetcher returned an
 *      empty shell with no schedule data.
 *
 * This module cross-references the extraction result against secondary
 * page signals to detect these failure modes and suggest retry strategies.
 */

import type { Page } from 'puppeteer';
import type { ScrapeResult, ValidatorResult, RetryHint } from '../core/types';
import { Logger } from '../core/logger';

const logger = new Logger('ExtractionValidator');

/**
 * Validate an extraction result against secondary page signals.
 *
 * @param result - The scraper's output (organization, locations, classes).
 * @param page - The live Puppeteer Page (optional — only available when
 *   the browser path was used).  If provided, the validator can inspect
 *   DOM state (button enabled/disabled, pagination indicators).
 * @param html - The raw HTML that was scraped.
 * @returns A ValidatorResult with confidence score and optional retry hint.
 */
export async function validateExtraction(
  result: ScrapeResult,
  page: Page | undefined,
  html: string,
): Promise<ValidatorResult> {
  const signals: string[] = [];
  let confidence = 1.0;
  let retryHint: RetryHint | undefined;

  // ── Check 1: Count plausibility ──────────────────────────
  const countResult = checkCountPlausibility(result);
  signals.push(countResult.signal);
  confidence *= countResult.factor;
  if (countResult.hint) retryHint = countResult.hint;

  // ── Check 2: Content coherence ───────────────────────────
  const coherenceResult = checkContentCoherence(result);
  signals.push(coherenceResult.signal);
  confidence *= coherenceResult.factor;
  if (coherenceResult.hint && !retryHint) retryHint = coherenceResult.hint;

  // ── Check 3: Duplicate detection ─────────────────────────
  const dupResult = checkDuplicates(result);
  signals.push(dupResult.signal);
  confidence *= dupResult.factor;
  if (dupResult.hint && !retryHint) retryHint = dupResult.hint;

  // ── Check 4: Pagination state (requires live Page) ───────
  if (page) {
    const pagResult = await checkPaginationState(page);
    signals.push(pagResult.signal);
    confidence *= pagResult.factor;
    if (pagResult.hint && !retryHint) retryHint = pagResult.hint;
  }

  // ── Check 5: Auth wall detection (requires live Page) ────
  if (page) {
    const authResult = await checkAuthWall(page, html);
    signals.push(authResult.signal);
    confidence *= authResult.factor;
    if (authResult.hint && !retryHint) retryHint = authResult.hint;
  }

  const valid = confidence >= 0.5;

  if (!valid) {
    logger.warn(
      `Validation FAILED (confidence: ${confidence.toFixed(2)}). ` +
        `Signals: ${signals.join('; ')}` +
        (retryHint ? `. Retry hint: ${retryHint}` : ''),
    );
  } else {
    logger.info(
      `Validation passed (confidence: ${confidence.toFixed(2)}). ` +
        `${result.classes.length} classes look legitimate.`,
    );
  }

  return { valid, confidence, signals, retryHint };
}

// ─── Individual checks ─────────────────────────────────────

interface CheckResult {
  signal: string;
  /** Multiplicative confidence factor (1.0 = no impact, 0.0 = certain failure). */
  factor: number;
  hint?: RetryHint;
}

/**
 * Check 1: Are the class counts plausible?
 *
 * WHY?
 * A gym with 0 classes extracted is almost certainly a scrape failure.
 * Fewer than 3 classes for what should be a full week is suspicious —
 * most gyms run at least 5-10 classes per week.
 */
function checkCountPlausibility(result: ScrapeResult): CheckResult {
  const count = result.classes.length;

  if (count === 0) {
    return {
      signal: `FAIL: 0 classes extracted — likely a rendering or CAPTCHA failure`,
      factor: 0.1,
      hint: 'wait-longer',
    };
  }

  if (count < 3) {
    return {
      signal: `WARN: Only ${count} class(es) extracted — may be partial data`,
      factor: 0.5,
      hint: 'paginate-forward',
    };
  }

  return {
    signal: `OK: ${count} classes extracted`,
    factor: 1.0,
  };
}

/**
 * Check 2: Are the class names real words or garbled markup?
 *
 * WHY?
 * If the scraper accidentally parsed HTML tags or JS code as class names,
 * they'll contain characters like `<`, `{`, `\u`.  Real class names
 * (e.g., "Power Yoga", "HIIT 45") don't contain these.
 */
function checkContentCoherence(result: ScrapeResult): CheckResult {
  if (result.classes.length === 0) {
    return { signal: 'SKIP: No classes to check for coherence', factor: 1.0 };
  }

  const garbledPattern = /[<>{}\[\]\\]/;
  const garbledCount = result.classes.filter((c) =>
    garbledPattern.test(c.name),
  ).length;
  const garbledRatio = garbledCount / result.classes.length;

  if (garbledRatio > 0.3) {
    return {
      signal:
        `FAIL: ${(garbledRatio * 100).toFixed(0)}% of class names contain ` +
        `markup characters — extraction likely parsed HTML instead of content`,
      factor: 0.2,
      hint: 'switch-to-browser',
    };
  }

  if (garbledRatio > 0) {
    return {
      signal: `WARN: ${garbledCount} class name(s) contain markup characters`,
      factor: 0.7,
    };
  }

  return {
    signal: 'OK: Class names appear coherent',
    factor: 1.0,
  };
}

/**
 * Check 3: Are all classes identical (loading skeleton / placeholder)?
 *
 * WHY?
 * If the page rendered a loading skeleton, all "classes" might have the
 * same placeholder text (e.g., "Loading…", "---", or identical entries).
 * Real schedules have variety in names and times.
 */
function checkDuplicates(result: ScrapeResult): CheckResult {
  if (result.classes.length <= 1) {
    return { signal: 'SKIP: Too few classes for duplicate check', factor: 1.0 };
  }

  // Build a set of unique (name + startTime) pairs.
  const seen = new Set<string>();
  for (const cls of result.classes) {
    seen.add(`${cls.name}::${cls.startTime}`);
  }

  const uniqueRatio = seen.size / result.classes.length;

  if (uniqueRatio < 0.3) {
    return {
      signal:
        `FAIL: ${(uniqueRatio * 100).toFixed(0)}% unique classes — ` +
        `likely a loading skeleton or placeholder content`,
      factor: 0.2,
      hint: 'wait-longer',
    };
  }

  if (uniqueRatio < 0.5) {
    return {
      signal: `WARN: Only ${(uniqueRatio * 100).toFixed(0)}% unique classes`,
      factor: 0.6,
    };
  }

  return {
    signal: `OK: ${seen.size}/${result.classes.length} classes are unique`,
    factor: 1.0,
  };
}

/**
 * Check 4: Is there an active pagination / "Next Day" button?
 *
 * WHY?
 * If a "Next Day" or "Next Week" button exists and is enabled, we may
 * have only scraped a single day's view.  The validator recommends
 * paginating forward to capture the full schedule.
 */
async function checkPaginationState(page: Page): Promise<CheckResult> {
  try {
    // Look for common pagination selectors.
    const paginationSelectors = [
      'button:not([disabled])',
      'a[href]',
    ];

    const paginationKeywords = [
      'next', 'forward', 'tomorrow', 'next day', 'next week',
      'arrow_forward', 'chevron_right', '→', '›', '»',
    ];

    for (const sel of paginationSelectors) {
      const elements = await page.$$(sel);
      for (const el of elements) {
        const text = await el.evaluate((e) => {
          return (
            (e.textContent?.trim().toLowerCase() ?? '') +
            ' ' +
            (e.getAttribute('aria-label')?.toLowerCase() ?? '') +
            ' ' +
            (e.getAttribute('title')?.toLowerCase() ?? '')
          );
        });

        for (const keyword of paginationKeywords) {
          if (text.includes(keyword)) {
            return {
              signal:
                `WARN: Active "${keyword}" button found — may have only scraped partial data`,
              factor: 0.7,
              hint: 'paginate-forward' as RetryHint,
            };
          }
        }
      }
    }
  } catch {
    // DOM inspection failed — non-fatal, just skip this check.
  }

  return {
    signal: 'OK: No active pagination buttons detected',
    factor: 1.0,
  };
}

/**
 * Check 5: Does the page look like a login wall?
 *
 * WHY?
 * If the scraper landed on a login page instead of the schedule, the
 * extraction will produce garbage.  Detect this early so the session
 * manager can re-authenticate.
 */
async function checkAuthWall(page: Page, html: string): Promise<CheckResult> {
  try {
    // Check for password fields.
    const hasPasswordField = await page.$('input[type="password"]');
    if (hasPasswordField) {
      return {
        signal: 'FAIL: Page contains a password field — likely a login wall',
        factor: 0.1,
        hint: 're-authenticate',
      };
    }
  } catch {
    // DOM query failed — fall back to HTML check.
  }

  // Check HTML for common login indicators.
  const loginPatterns = [
    /sign\s*in/i,
    /log\s*in/i,
    /enter\s*your\s*password/i,
    /authentication\s*required/i,
  ];

  // Only flag if multiple indicators are present (avoid false positives
  // from pages that mention "sign in" in a footer link).
  const matchCount = loginPatterns.filter((p) => p.test(html)).length;
  if (matchCount >= 2) {
    return {
      signal:
        `WARN: Page contains ${matchCount} login-related phrases — possible auth wall`,
      factor: 0.4,
      hint: 're-authenticate',
    };
  }

  return {
    signal: 'OK: No auth wall detected',
    factor: 1.0,
  };
}
