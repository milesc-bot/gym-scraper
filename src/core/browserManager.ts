/**
 * browserManager.ts — Singleton manager for a shared Puppeteer browser instance.
 *
 * WHY a singleton instead of launching a new browser per URL?
 * ────────────────────────────────────────────────────────────
 * 1. **RAM:**  Each Chromium process consumes 100–300 MB.  If we scrape 50 gyms
 *    in a run and launch a fresh browser each time, peak memory can exceed 10 GB
 *    and the host will start OOM-killing processes.
 * 2. **Startup cost:**  Launching Chromium takes 1–3 seconds.  Reusing one browser
 *    and creating lightweight *contexts* (incognito tabs) drops per-page overhead
 *    to ~50 ms.
 * 3. **Zombie prevention:**  If a scrape throws mid-run and nobody calls
 *    `browser.close()`, the orphaned Chromium process keeps consuming RAM until
 *    the server is restarted.  The `withPage()` API wraps every usage in
 *    try/finally so the *context* (tab) is always disposed — and the process-exit
 *    hook closes the browser itself.
 *
 * HOW it works:
 *   • `BrowserManager.getInstance()` lazily creates ONE browser.
 *   • Callers use `withPage(fn)` which opens a new *incognito browser context*,
 *     hands `fn` a fresh `Page`, and guarantees `context.close()` in `finally`.
 *   • On process exit (`SIGINT`, `SIGTERM`) the browser is closed automatically.
 */

import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, BrowserContext, Page } from 'puppeteer';

// WHY apply the stealth plugin here (at the module level)?
// puppeteer-extra plugins must be registered *before* the first `launch()` call.
// Doing it in the module scope guarantees the plugin is active regardless of
// which code path calls `getInstance()` first.
puppeteer.use(StealthPlugin());

export class BrowserManager {
  // ── Singleton plumbing ─────────────────────────────────

  private static instance: BrowserManager | null = null;
  private browser: Browser | null = null;

  /** Private constructor — callers must use `getInstance()`. */
  private constructor() {}

  /**
   * Return the single BrowserManager instance, creating it on first access.
   *
   * WHY lazy initialisation?
   * Unit tests or CLI help screens should not spawn Chromium just because the
   * module was imported.  The browser is only launched when `withPage()` is
   * called for the first time.
   */
  static getInstance(): BrowserManager {
    if (!BrowserManager.instance) {
      BrowserManager.instance = new BrowserManager();
    }
    return BrowserManager.instance;
  }

  // ── Core API ───────────────────────────────────────────

  /**
   * Execute `fn` with a fresh Puppeteer Page, then dispose the context.
   *
   * WHY accept a callback instead of returning a Page?
   * The callback pattern ("loan pattern" / "using pattern") makes it
   * *impossible* for the caller to forget cleanup.  The context is always
   * closed in `finally`, even if `fn` throws.
   *
   * @example
   *   const html = await BrowserManager.getInstance().withPage(async (page) => {
   *     await page.goto('https://example-gym.com/schedule');
   *     return page.content();
   *   });
   */
  async withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    const browser = await this.ensureBrowser();

    // WHY an incognito context instead of a plain `browser.newPage()`?
    // Incognito contexts get their own cookie jar, localStorage, and cache.
    // This prevents session bleed between different gym sites and lets us
    // close the entire context (+ all its pages) in one call.
    const context: BrowserContext = await browser.createBrowserContext();
    const page: Page = await context.newPage();

    try {
      // WHY set a realistic viewport?
      // Many gym sites serve different markup (or block requests entirely) for
      // viewports that look like headless bots (e.g. 800×600).
      await page.setViewport({ width: 1366, height: 768 });

      return await fn(page);
    } finally {
      // GUARANTEED cleanup — the context (and its page) is closed even if
      // `fn` throws.  This is the key defence against zombie tabs.
      await context.close().catch(() => {
        // Swallow close errors — the browser may have already crashed.
        // The important thing is we *tried* to clean up.
      });
    }
  }

  /**
   * Gracefully shut down the browser.  Called automatically on process exit,
   * but can be invoked manually at the end of a batch run.
   */
  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }

  // ── Internals ──────────────────────────────────────────

  /**
   * Lazily launch the shared Chromium instance.
   *
   * WHY headless: true (the new headless mode)?
   * The "new" headless mode (`headless: true` in Puppeteer ≥ 21) uses the
   * *same* browser binary as headed mode, which makes its TLS fingerprint
   * and JS environment indistinguishable from a real desktop browser.
   * Combined with the stealth plugin this is the strongest anti-detection
   * posture without a full headed display.
   */
  private async ensureBrowser(): Promise<Browser> {
    if (!this.browser || !this.browser.connected) {
      this.browser = await puppeteer.launch({
        headless: true,
        args: [
          // WHY these flags?
          // --no-sandbox:  Required inside Docker / CI where Chrome refuses to
          //   start otherwise.  Safe because our scraper only visits URLs we control.
          '--no-sandbox',
          '--disable-setuid-sandbox',
          // --disable-dev-shm-usage:  Docker's default /dev/shm is 64 MB which
          //   causes tab crashes.  This flag tells Chrome to write to /tmp instead.
          '--disable-dev-shm-usage',
        ],
      });

      // WHY register exit hooks?
      // If the Node process is killed (Ctrl-C, SIGTERM from a container
      // orchestrator) we need to close the browser so Chromium doesn't linger
      // as a zombie.
      this.registerExitHooks();
    }
    return this.browser;
  }

  /**
   * Ensure the browser is closed when the Node process exits.
   *
   * WHY `once` instead of `on`?
   * We only need to run cleanup a single time.  Using `once` prevents
   * double-close if multiple signals fire in quick succession.
   */
  private registerExitHooks(): void {
    const cleanup = async () => {
      await this.close();
      process.exit(0);
    };

    process.once('SIGINT', cleanup);
    process.once('SIGTERM', cleanup);
  }
}
