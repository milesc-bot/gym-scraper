/**
 * dayWorkerPool.ts — Parallel schedule extraction via API pattern discovery.
 *
 * THE PROBLEM WITH SEQUENTIAL SCRAPING
 * ─────────────────────────────────────
 * Clicking Monday → Tuesday → … → Sunday sequentially means 7 full page
 * loads, 7 networkidle2 waits, and 7 rounds of WAF scrutiny.  At ~30 s
 * per page, a full week takes 3.5 minutes — and the long session time
 * increases detection risk.
 *
 * THE PARALLEL APPROACH
 * ─────────────────────
 * Most gym schedule widgets (MindBody, Glofox, Marianatek) fetch data via
 * XHR/fetch with a date parameter.  If we can discover that URL pattern,
 * we can replay the same request for all 7 days concurrently using the
 * lightweight got-scraping HTTP client — no browser needed.
 *
 * ARCHITECTURE
 * ────────────
 *   1. **Discovery** — During the initial page load, intercept XHR/fetch
 *      requests and look for date-parameterised API calls.
 *   2. **Spawning** — Generate 7 date variants and fire concurrent GETs/POSTs.
 *   3. **Fallback** — If no API pattern is found (server-rendered pages),
 *      fall back to sequential browser clicks via the Navigation Planner.
 */

import { DateTime } from 'luxon';
import type { Page, HTTPRequest } from 'puppeteer';
import type { DayApiPattern, AgentConfig } from '../core/types';
import { lightFetch } from '../middleware/lightFetcher';
import { getApiRateLimiter } from '../middleware/compliance';
import { Logger } from '../core/logger';

const logger = new Logger('DayWorkerPool');

// ─── API Pattern Discovery ─────────────────────────────────

/**
 * Intercept XHR/fetch requests during page load to discover date-based
 * API patterns.
 *
 * WHY intercept during page load?
 * Most schedule widgets fire their initial data fetch as part of the
 * page's boot sequence.  By capturing these requests, we learn the exact
 * URL, method, headers, and body format the widget uses — then replay it.
 *
 * @param page - The Puppeteer Page (must be called BEFORE page.goto()).
 * @returns Discovered API patterns (may be empty if the site is SSR).
 */
export async function discoverApiPatterns(
  page: Page,
): Promise<DayApiPattern[]> {
  const patterns: DayApiPattern[] = [];
  const capturedRequests: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    postData?: string;
  }> = [];

  // Set up request interception.
  await page.setRequestInterception(true);

  page.on('request', (request: HTTPRequest) => {
    const resourceType = request.resourceType();

    // Only capture XHR/fetch — skip images, CSS, etc.
    if (resourceType === 'xhr' || resourceType === 'fetch') {
      capturedRequests.push({
        url: request.url(),
        method: request.method(),
        headers: request.headers(),
        postData: request.postData(),
      });
    }

    // MUST call continue() or the request will hang.
    request.continue();
  });

  // Return a function that analyses captured requests after the page loads.
  // The caller should call this AFTER page.goto() completes.
  return patterns; // Placeholder — real analysis happens in analyseRequests().
}

/**
 * Analyse captured requests to find date-parameterised API calls.
 *
 * Call this AFTER the page has finished loading and the initial widget
 * data fetch has fired.
 */
export function analyseInterceptedRequests(
  requests: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    postData?: string;
  }>,
): DayApiPattern[] {
  const patterns: DayApiPattern[] = [];

  // Common date formats to look for in URLs and POST bodies.
  const datePatterns = [
    // ISO format: 2026-02-10
    /(\d{4}-\d{2}-\d{2})/,
    // US format: 02/10/2026
    /(\d{2}\/\d{2}\/\d{4})/,
    // Timestamp: 1739145600
    /(\d{10,13})/,
  ];

  for (const req of requests) {
    const url = req.url;

    // Check URL for date parameters.
    for (const pattern of datePatterns) {
      const urlMatch = url.match(pattern);
      if (urlMatch) {
        const dateValue = urlMatch[1];
        const template = url.replace(dateValue, '{{date}}');

        // Try to identify which query param holds the date.
        let dateParam = 'date';
        try {
          const parsed = new URL(url);
          for (const [key, value] of parsed.searchParams) {
            if (value === dateValue) {
              dateParam = key;
              break;
            }
          }
        } catch {
          // URL parse failed — use default param name.
        }

        patterns.push({
          urlTemplate: template,
          method: req.method as 'GET' | 'POST',
          dateParam,
          headers: sanitiseHeaders(req.headers),
        });

        logger.info(
          `Discovered API pattern: ${req.method} ${template} ` +
            `(date param: "${dateParam}")`,
        );
        break; // One match per request is enough.
      }
    }

    // Check POST body for date fields.
    if (req.method === 'POST' && req.postData) {
      try {
        const body = JSON.parse(req.postData);
        const dateFields = findDateFields(body);
        if (dateFields.length > 0) {
          const bodyTemplate = { ...body };
          for (const field of dateFields) {
            setNestedValue(bodyTemplate, field.path, '{{date}}');
          }

          patterns.push({
            urlTemplate: url,
            method: 'POST',
            dateParam: dateFields[0].path.join('.'),
            bodyTemplate,
            headers: sanitiseHeaders(req.headers),
          });

          logger.info(
            `Discovered POST API pattern: ${url} ` +
              `(date field: "${dateFields[0].path.join('.')}")`,
          );
        }
      } catch {
        // Not JSON — skip.
      }
    }
  }

  return patterns;
}

// ─── Parallel Worker Spawning ───────────────────────────────

export interface DayWorkerResult {
  date: string;
  success: boolean;
  html?: string;
  error?: string;
}

/**
 * Fetch all 7 days of schedule data in parallel using a discovered API pattern.
 *
 * @param pattern - The API pattern to replay.
 * @param weekStartDate - The Monday of the target week (ISO format).
 * @param cookieHeader - Session cookies as a "name=val; name=val" string.
 * @param config - Agent config for rate limiting.
 * @returns Results for each day (some may have failed).
 */
export async function fetchWeekParallel(
  pattern: DayApiPattern,
  weekStartDate: string,
  cookieHeader: string,
  config: AgentConfig,
): Promise<DayWorkerResult[]> {
  // Generate 7 date strings (Mon → Sun).
  const monday = DateTime.fromISO(weekStartDate);
  const dates: string[] = [];
  for (let i = 0; i < 7; i++) {
    dates.push(monday.plus({ days: i }).toISODate()!);
  }

  logger.info(
    `Spawning ${dates.length} parallel workers for ` +
      `${dates[0]} → ${dates[dates.length - 1]}`,
  );

  // Get the rate limiter for this domain.
  let hostname: string;
  try {
    hostname = new URL(pattern.urlTemplate.replace('{{date}}', dates[0])).hostname;
  } catch {
    hostname = 'unknown';
  }
  const limiter = getApiRateLimiter(hostname);

  // Fire all requests concurrently, throttled by the rate limiter.
  const promises = dates.map((date) =>
    limiter.schedule(() => fetchSingleDay(pattern, date, cookieHeader)),
  );

  const settled = await Promise.allSettled(promises);

  const results: DayWorkerResult[] = settled.map((s, i) => {
    if (s.status === 'fulfilled') {
      return s.value;
    }
    return {
      date: dates[i],
      success: false,
      error: s.reason?.message ?? 'Unknown error',
    };
  });

  const successCount = results.filter((r) => r.success).length;
  logger.info(
    `Parallel fetch complete: ${successCount}/${dates.length} days succeeded`,
  );

  return results;
}

// ─── Single day fetch ───────────────────────────────────────

async function fetchSingleDay(
  pattern: DayApiPattern,
  date: string,
  cookieHeader: string,
): Promise<DayWorkerResult> {
  const url = pattern.urlTemplate.replace(/\{\{date\}\}/g, date);

  try {
    let body: string | undefined;
    if (pattern.method === 'POST' && pattern.bodyTemplate) {
      body = JSON.stringify(pattern.bodyTemplate)
        .replace(/"\{\{date\}\}"/g, `"${date}"`);
    }

    const result = await lightFetch(url, {
      method: pattern.method,
      headers: {
        ...pattern.headers,
        'content-type': pattern.method === 'POST' ? 'application/json' : '',
      },
      cookieHeader,
      body,
    });

    if (result.statusCode >= 200 && result.statusCode < 300) {
      return { date, success: true, html: result.body };
    }

    return {
      date,
      success: false,
      error: `HTTP ${result.statusCode}`,
    };
  } catch (err) {
    return {
      date,
      success: false,
      error: (err as Error).message,
    };
  }
}

// ─── Request interception setup ─────────────────────────────

/**
 * Set up request interception on a page and return captured XHR/fetch requests.
 *
 * WHY return a capture function instead of using discoverApiPatterns?
 * The page might already have request interception enabled for other
 * reasons.  This approach lets the caller control when to start/stop
 * capturing and when to analyse results.
 */
export async function setupRequestCapture(
  page: Page,
): Promise<{
  getCapturedRequests: () => Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    postData?: string;
  }>;
}> {
  const captured: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    postData?: string;
  }> = [];

  await page.setRequestInterception(true);

  page.on('request', (request: HTTPRequest) => {
    const resourceType = request.resourceType();

    if (resourceType === 'xhr' || resourceType === 'fetch') {
      captured.push({
        url: request.url(),
        method: request.method(),
        headers: request.headers(),
        postData: request.postData() ?? undefined,
      });
    }

    request.continue();
  });

  return {
    getCapturedRequests: () => [...captured],
  };
}

// ─── Helpers ────────────────────────────────────────────────

/** Remove sensitive or non-replayable headers. */
function sanitiseHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  const skip = new Set([
    'host',
    'content-length',
    'transfer-encoding',
    'connection',
    'cookie',          // We pass cookies separately.
    'sec-fetch-site',
    'sec-fetch-mode',
    'sec-fetch-dest',
  ]);

  for (const [key, value] of Object.entries(headers)) {
    if (!skip.has(key.toLowerCase())) {
      result[key] = value;
    }
  }
  return result;
}

/** Recursively find fields in an object that look like date values. */
function findDateFields(
  obj: Record<string, unknown>,
  path: string[] = [],
): Array<{ path: string[]; value: string }> {
  const results: Array<{ path: string[]; value: string }> = [];
  const datePattern = /^\d{4}-\d{2}-\d{2}/;

  for (const [key, value] of Object.entries(obj)) {
    const currentPath = [...path, key];
    if (typeof value === 'string' && datePattern.test(value)) {
      results.push({ path: currentPath, value });
    } else if (typeof value === 'object' && value !== null) {
      results.push(
        ...findDateFields(value as Record<string, unknown>, currentPath),
      );
    }
  }
  return results;
}

/** Set a value at a nested path in an object. */
function setNestedValue(
  obj: Record<string, unknown>,
  path: string[],
  value: unknown,
): void {
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < path.length - 1; i++) {
    current = current[path[i]] as Record<string, unknown>;
  }
  current[path[path.length - 1]] = value;
}
