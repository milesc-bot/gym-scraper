/**
 * stealthFetcher.ts — Intelligent fetch layer with light/browser fallback.
 *
 * FETCH STRATEGY
 * ──────────────
 * 1. **Compliance gate:**  Check robots.txt and rate-limit before fetching.
 * 2. **Light path first:**  Try got-scraping (fast, TLS-impersonating HTTP).
 * 3. **Content check:**  If the light response looks like an empty SPA shell
 *    (no schedule-like tokens), fall back to full Puppeteer.
 * 4. **Browser path:**  Full Puppeteer with stealth + fingerprint noise +
 *    human idle behaviour.
 * 5. **Status handling:**  402 → Pay-to-Crawl abort.  401/403 → auth wall flag.
 *
 * REFACTORED RETURN TYPE
 * ──────────────────────
 * This module now returns a `FetchResult` that includes the live Page and
 * BrowserContext (when the browser path was used).  The caller is responsible
 * for closing the context after validation.  This enables the extraction
 * validator to inspect DOM state before cleanup.
 */

import { BrowserManager } from '../core/browserManager';
import { Logger } from '../core/logger';
import { lightFetch } from './lightFetcher';
import { isPaywallResponse, isAllowedByRobots, getRateLimiter, getBotUserAgent } from './compliance';
import { createHumanCursor, randomIdle } from './humanBehavior';
import { loadAgentConfig, type FetchResult } from '../core/types';

const logger = new Logger('StealthFetcher');

/**
 * Fetch a URL with the full stealth pipeline.
 *
 * @param url - The target page to fetch.
 * @param options - Optional overrides.
 * @returns A FetchResult.  If the browser path was used, `page` and `context`
 *   are populated — the caller MUST close `context` when done.
 */
export async function fetchWithStealth(
  url: string,
  options?: {
    /** Force the browser path (skip light fetch). */
    forceBrowser?: boolean;
    /** Skip robots.txt check. */
    skipRobots?: boolean;
    /** Skip rate limiting. */
    skipRateLimit?: boolean;
  },
): Promise<FetchResult> {
  const config = loadAgentConfig();

  // ── Compliance gate ──────────────────────────────────────
  if (!options?.skipRobots) {
    const allowed = await isAllowedByRobots(url, config);
    if (!allowed) {
      logger.warn(`robots.txt disallows ${url} — skipping`);
      return {
        html: '',
        statusCode: 0,
        fetchMethod: 'light',
      };
    }
  }

  // Rate limiting — wait for our turn.
  if (!options?.skipRateLimit) {
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      hostname = 'unknown';
    }
    const limiter = getRateLimiter(hostname, config);
    await limiter.schedule(() => Promise.resolve());
  }

  // ── Light fetch (try first unless forced to browser) ─────
  if (!options?.forceBrowser) {
    try {
      logger.info(`Trying light fetch for ${url}…`);
      const result = await lightFetch(url);

      // Check for paywall.
      if (isPaywallResponse(result.statusCode)) {
        logger.warn(
          `HTTP 402 Pay-to-Crawl firewall detected for ${url} — ` +
            `this site requires a paid crawling agreement.  Skipping.`,
        );
        return {
          html: '',
          statusCode: 402,
          fetchMethod: 'light',
        };
      }

      // Check if the response has actual schedule content.
      // If the HTML is mostly an SPA shell with no time-like tokens,
      // the schedule is loaded via JS and we need the browser.
      if (result.statusCode === 200 && looksLikeRenderedSchedule(result.body)) {
        logger.info(`Light fetch returned rendered content — using it`);
        return {
          html: result.body,
          statusCode: result.statusCode,
          fetchMethod: 'light',
        };
      }

      if (result.statusCode === 200) {
        logger.info(
          `Light fetch returned HTML but no schedule tokens — ` +
            `falling back to browser for JS rendering`,
        );
      }
    } catch (err) {
      logger.warn(`Light fetch failed — falling back to browser: ${(err as Error).message}`);
    }
  }

  // ── Browser fetch (full Puppeteer) ───────────────────────
  logger.info(`Browser-fetching ${url}…`);

  const manager = BrowserManager.getInstance();
  const { page, context } = await manager.borrowPage();

  try {
    const response = await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 30_000,
    });

    const statusCode = response?.status() ?? 0;

    // Check for paywall on the browser path too.
    if (isPaywallResponse(statusCode)) {
      logger.warn(
        `HTTP 402 Pay-to-Crawl firewall detected for ${url} — skipping`,
      );
      await context.close().catch(() => {});
      return {
        html: '',
        statusCode: 402,
        fetchMethod: 'browser',
      };
    }

    // Extra wait for late-rendering widgets.
    await page.evaluate(() => new Promise((r) => setTimeout(r, 1_000)));

    // Human idle behaviour — generate mouse/scroll telemetry.
    try {
      const cursor = createHumanCursor(page);
      await randomIdle(page, cursor);
    } catch {
      // Idle simulation failed — non-fatal, page content is still valid.
    }

    const html = await page.content();

    logger.info(
      `Browser fetch complete — HTTP ${statusCode} for ${url}`,
    );

    // Return page + context for the validator to inspect.
    // The CALLER is responsible for closing the context.
    return {
      html,
      statusCode,
      page,
      context,
      fetchMethod: 'browser',
    };
  } catch (err) {
    // On error, clean up and re-throw.
    await context.close().catch(() => {});
    throw err;
  }
}

/**
 * Legacy wrapper that returns just the HTML string (backwards compatible).
 *
 * WHY keep this?
 * Existing callers (and tests) that only need the HTML can use this
 * simpler signature.  The context is auto-closed after extraction.
 */
export async function fetchHtml(url: string): Promise<string> {
  const result = await fetchWithStealth(url);

  // Auto-close the browser context if one was created.
  if (result.context) {
    await result.context.close().catch(() => {});
  }

  return result.html;
}

// ─── Helpers ────────────────────────────────────────────────

/**
 * Quick heuristic: does this HTML look like it contains a rendered schedule?
 *
 * WHY not just check for any HTML?
 * SPA shells (React, Vue) return valid HTML with a single `<div id="root">`
 * and all content is loaded via JS.  We need to distinguish "HTML that
 * already has schedule data" from "HTML that needs JS to render."
 */
function looksLikeRenderedSchedule(html: string): boolean {
  // Look for time-like patterns (e.g. "6:00 PM", "18:00").
  const timePattern = /\d{1,2}(?::\d{2})?\s*(?:AM|PM|am|pm)/;
  const dayPattern =
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

  const hasTime = timePattern.test(html);
  const hasDay = dayPattern.test(html);

  // If we see both a time and a day name, it's likely a rendered schedule.
  return hasTime && hasDay;
}
