/**
 * stealthFetcher.ts — Browser-based HTTP fetch that minimises bot detection.
 *
 * WHY use a full browser instead of plain HTTP (axios / node-fetch)?
 * ─────────────────────────────────────────────────────────────────
 * 1. **JavaScript rendering:**  Most gym schedule widgets (MindBody, Glofox)
 *    load class data via XHR / React after the initial HTML.  A plain HTTP GET
 *    only returns the empty shell.
 * 2. **Anti-bot evasion:**  Cloudflare, Datadome, and similar services inspect
 *    TLS fingerprints, JS environment APIs, and behavioural signals.  Puppeteer
 *    with the stealth plugin patches all known detection vectors (navigator
 *    properties, WebGL vendor, chrome.runtime, etc.).
 * 3. **Cookie / session handling:**  Some gyms gate their schedule behind a
 *    consent click or region selector.  A real browser lets us interact with
 *    those flows if needed.
 *
 * WHY delegate to BrowserManager instead of launching our own browser?
 * ───────────────────────────────────────────────────────────────────
 * BrowserManager owns the single Chromium process and provides short-lived
 * incognito contexts.  This means:
 *   • We never leak a browser process (the withPage try/finally handles it).
 *   • Startup cost is paid once, not per URL.
 *   • We don't have to think about cleanup here — BrowserManager does it.
 */

import { BrowserManager } from '../core/browserManager';
import { Logger } from '../core/logger';

const logger = new Logger('StealthFetcher');

/**
 * Navigate to `url` inside a stealth-enabled browser and return the fully
 * rendered HTML.
 *
 * @param url - The target page to fetch (e.g. "https://gym.com/schedule").
 * @returns The full page HTML after JavaScript execution.
 *
 * WHY `waitUntil: 'networkidle2'`?
 * "networkidle2" waits until there are ≤ 2 in-flight network requests for
 * 500 ms.  This strikes a balance between:
 *   • `'domcontentloaded'` — too early; AJAX data hasn't arrived yet.
 *   • `'networkidle0'`     — too strict; analytics pixels and websockets
 *     may never fully settle, causing a 30-second timeout.
 */
export async function fetchWithStealth(url: string): Promise<string> {
  logger.info(`Navigating to ${url}…`);

  const html = await BrowserManager.getInstance().withPage(async (page) => {
    // WHY a 30-second timeout?
    // Gym sites on shared hosting can be slow.  30 s is generous enough to
    // survive a cold CDN cache miss without blocking the pipeline forever.
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 30_000,
    });

    // WHY wait an extra second?
    // Some widgets (e.g. Glofox) fire a final render pass ~500 ms after
    // networkidle.  A short sleep catches those without meaningfully slowing
    // the overall run.
    await page.evaluate(() => new Promise((r) => setTimeout(r, 1_000)));

    return page.content();
  });

  logger.info(`Fetched page successfully — bypassed anti-bot check for ${url}`);
  return html;
}
