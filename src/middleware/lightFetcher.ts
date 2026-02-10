/**
 * lightFetcher.ts — TLS-impersonating HTTP client for pages that don't need JS.
 *
 * WHY a separate "light" fetch path?
 * ──────────────────────────────────
 * 1. **Speed:**  A plain HTTP GET completes in 200–500 ms vs. 5–15 s for a full
 *    Puppeteer page load.  For server-rendered HTML (no client-side schedule
 *    widget), the light path is 10–30× faster.
 * 2. **Fingerprint diversity:**  got-scraping generates its own TLS Client Hello
 *    that impersonates Chrome 130+.  This gives us a *second* fingerprint
 *    profile distinct from Puppeteer's bundled Chromium, making it harder for
 *    defenders to build a single blocking rule for our scraper.
 * 3. **Resource efficiency:**  No Chromium process = no 100–300 MB RAM overhead
 *    per fetch.  In batch runs this lets us scan lightweight pages without
 *    touching the browser singleton at all.
 *
 * WHY dynamic import?
 * ───────────────────
 * got-scraping v4 is ESM-only (built on got v14).  Our project targets CommonJS.
 * A dynamic `import()` lets Node load the ESM module at runtime without
 * requiring the entire project to switch to ESM.
 */

import { Logger } from '../core/logger';

const logger = new Logger('LightFetcher');

// Lazy-loaded because got-scraping v4 is ESM-only.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let gotScrapingModule: any = null;

async function getGotScraping() {
  if (!gotScrapingModule) {
    gotScrapingModule = await import('got-scraping');
  }
  return gotScrapingModule;
}

export interface LightFetchResult {
  body: string;
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Fetch a URL using got-scraping with browser-grade TLS impersonation.
 *
 * @param url - The target URL to fetch.
 * @param options - Optional overrides for headers, cookies, etc.
 * @returns The response body, status code, and headers.
 *
 * WHY impersonate Chrome 130+?
 * JA4+ signature databases catalogue the TLS Client Hello of every major
 * browser version.  By impersonating a recent Chrome release, our TCP
 * handshake is indistinguishable from a real user's browser — defeating
 * the first layer of bot detection before any HTTP headers are even read.
 */
export async function lightFetch(
  url: string,
  options?: {
    headers?: Record<string, string>;
    cookieHeader?: string;
    method?: 'GET' | 'POST';
    body?: string;
    timeout?: number;
  },
): Promise<LightFetchResult> {
  logger.info(`Light-fetching ${url}…`);

  const { gotScraping } = await getGotScraping();

  const headers: Record<string, string> = {
    ...options?.headers,
  };

  if (options?.cookieHeader) {
    headers['cookie'] = options.cookieHeader;
  }

  const response = await gotScraping({
    url,
    method: options?.method ?? 'GET',
    headers,
    body: options?.body,
    timeout: { request: options?.timeout ?? 30_000 },
    // WHY headerGeneratorOptions?
    // got-scraping uses these to auto-generate a realistic set of HTTP
    // headers (Accept, Accept-Language, sec-ch-ua, etc.) that match the
    // TLS fingerprint being impersonated.  Without this, the mismatch
    // between a Chrome TLS handshake and non-Chrome headers is a dead
    // giveaway.
    headerGeneratorOptions: {
      browsers: [{ name: 'chrome', minVersion: 130 }],
      devices: ['desktop'],
      operatingSystems: ['macos', 'windows'],
    },
  });

  const statusCode = response.statusCode ?? 0;
  logger.info(`Light-fetch complete — HTTP ${statusCode} for ${url}`);

  return {
    body: response.body as string,
    statusCode,
    headers: response.headers as Record<string, string | string[] | undefined>,
  };
}
