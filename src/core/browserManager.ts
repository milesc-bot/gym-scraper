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
 * UPGRADES IN THIS VERSION
 * ────────────────────────
 * • Fingerprint noise injection (Canvas / WebGL / AudioContext)
 * • Randomised `--lang` and `--accept-lang` Chrome flags per session
 * • Custom User-Agent header injection
 * • Session manager integration (login state monitoring, cookie loading)
 * • Hardware profile selection (per-session, for fingerprint consistency)
 */

import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, BrowserContext, Page } from 'puppeteer';
import { injectFingerprintNoise } from '../middleware/fingerprintNoise';
import { pickRandomProfile, type HardwareProfile } from './hardwareProfiles';
import { getBotUserAgent } from '../middleware/compliance';
import { attachLoginMonitor, loadSavedCookies } from '../agents/sessionManager';
import type { AgentConfig } from './types';
import { loadAgentConfig } from './types';
import { Logger } from './logger';

const logger = new Logger('BrowserManager');

// WHY apply the stealth plugin here (at the module level)?
// puppeteer-extra plugins must be registered *before* the first `launch()` call.
// Doing it in the module scope guarantees the plugin is active regardless of
// which code path calls `getInstance()` first.
puppeteer.use(StealthPlugin());

// Randomised accept-language pools for fingerprint diversity.
const ACCEPT_LANGUAGES = [
  'en-US,en;q=0.9',
  'en-GB,en;q=0.9',
  'en-US,en;q=0.9,fr;q=0.8',
  'en-US,en;q=0.9,de;q=0.8',
  'en-US,en;q=0.9,es;q=0.8',
  'en-CA,en;q=0.9',
  'en-AU,en;q=0.9,en-US;q=0.8',
];

export class BrowserManager {
  // ── Singleton plumbing ─────────────────────────────────

  private static instance: BrowserManager | null = null;
  private browser: Browser | null = null;
  private config: AgentConfig;
  /** Hardware profile selected for this session — consistent across all pages. */
  private hwProfile: HardwareProfile;
  /** Accept-Language value selected for this session. */
  private acceptLang: string;

  /** Private constructor — callers must use `getInstance()`. */
  private constructor() {
    this.config = loadAgentConfig();
    this.hwProfile = pickRandomProfile();
    this.acceptLang =
      ACCEPT_LANGUAGES[Math.floor(Math.random() * ACCEPT_LANGUAGES.length)];

    logger.info(
      `Session profile: ${this.hwProfile.platform} / ` +
        `${this.hwProfile.webglRenderer.slice(0, 40)}… / ` +
        `lang=${this.acceptLang.split(',')[0]}`,
    );
  }

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
   * Execute `fn` with a fully-instrumented Puppeteer Page, then dispose the context.
   *
   * "Fully instrumented" means:
   *   1. Stealth plugin active (navigator patching, etc.)
   *   2. Fingerprint noise injected (Canvas/WebGL/AudioContext)
   *   3. Custom User-Agent header set
   *   4. Login state monitor attached
   *   5. Saved cookies loaded (if available)
   *   6. Realistic viewport set
   *
   * The callback pattern ("loan pattern") makes it *impossible* for the
   * caller to forget cleanup.
   */
  async withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    const browser = await this.ensureBrowser();

    const context: BrowserContext = await browser.createBrowserContext();
    const page: Page = await context.newPage();

    try {
      // ── 1. Viewport ──────────────────────────────────────
      await page.setViewport({
        width: this.hwProfile.screen[0] > 1920 ? 1920 : this.hwProfile.screen[0],
        height: this.hwProfile.screen[1] > 1080 ? 1080 : this.hwProfile.screen[1],
      });

      // ── 2. Custom User-Agent header ──────────────────────
      // WHY setExtraHTTPHeaders instead of setUserAgent?
      // setExtraHTTPHeaders merges with existing headers, preserving
      // the stealth plugin's other header patches.
      await page.setExtraHTTPHeaders({
        'accept-language': this.acceptLang,
      });

      // ── 3. Fingerprint noise injection ───────────────────
      await injectFingerprintNoise(page, this.hwProfile);

      // ── 4. Login state monitor ───────────────────────────
      attachLoginMonitor(page, this.config);

      // ── 5. Load saved cookies ────────────────────────────
      await loadSavedCookies(page, this.config);

      return await fn(page);
    } finally {
      await context.close().catch(() => {});
    }
  }

  /**
   * Extended version of `withPage` that returns the page and context
   * WITHOUT auto-closing — the caller is responsible for cleanup.
   *
   * WHY?
   * The extraction validator needs the live Page to inspect DOM state
   * (button enabled/disabled, pagination indicators) AFTER scraping
   * but BEFORE the context is closed.
   */
  async borrowPage(): Promise<{ page: Page; context: BrowserContext }> {
    const browser = await this.ensureBrowser();
    const context: BrowserContext = await browser.createBrowserContext();
    const page: Page = await context.newPage();

    // Apply the same instrumentation as withPage.
    await page.setViewport({
      width: this.hwProfile.screen[0] > 1920 ? 1920 : this.hwProfile.screen[0],
      height: this.hwProfile.screen[1] > 1080 ? 1080 : this.hwProfile.screen[1],
    });

    await page.setExtraHTTPHeaders({
      'accept-language': this.acceptLang,
    });

    await injectFingerprintNoise(page, this.hwProfile);
    attachLoginMonitor(page, this.config);
    await loadSavedCookies(page, this.config);

    return { page, context };
  }

  /**
   * Gracefully shut down the browser.
   */
  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }

  /**
   * Get the current agent config.
   */
  getConfig(): AgentConfig {
    return this.config;
  }

  // ── Internals ──────────────────────────────────────────

  private async ensureBrowser(): Promise<Browser> {
    if (!this.browser || !this.browser.connected) {
      this.browser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          // Randomise the browser language to vary the fingerprint.
          `--lang=${this.acceptLang.split(',')[0].split(';')[0]}`,
        ],
      });

      this.registerExitHooks();
    }
    return this.browser;
  }

  private registerExitHooks(): void {
    const cleanup = async () => {
      await this.close();
      process.exit(0);
    };

    process.once('SIGINT', cleanup);
    process.once('SIGTERM', cleanup);
  }
}
