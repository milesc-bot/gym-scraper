/**
 * scrapers/index.ts — Scraper factory that selects the right parser for a page.
 *
 * WHY a factory instead of hardcoding GenericScraper everywhere?
 * ──────────────────────────────────────────────────────────────
 * Gym schedule pages are served by different platforms — MindBody, Glofox,
 * Marianatek, or plain custom HTML.  Each platform has distinctive DOM
 * signatures (specific script tags, CSS classes, data attributes).
 *
 * The factory inspects the HTML for these signals and returns the most
 * specialised scraper available.  This means:
 *   1. GymScanner never needs to know *which* scraper is running.
 *   2. Adding support for a new platform is a two-step process:
 *        a) Create `src/scrapers/mindBodyScraper.ts` extending BaseScraper.
 *        b) Add a detection rule here — done.
 *   3. The generic scraper always acts as the fallback, so unknown sites still
 *      get *some* data extracted rather than an outright failure.
 */

import type { BaseScraper } from './baseScraper';
import { GenericScraper } from './genericScraper';

/**
 * Inspect `html` and return the best available scraper.
 *
 * Detection is intentionally ordered from *most specific* to *least specific*
 * so that a MindBody embed doesn't accidentally fall through to the generic
 * parser (which would still work, but a dedicated parser would do better).
 *
 * @param html - The full page HTML returned by StealthFetcher.
 * @returns An instance of the most appropriate BaseScraper subclass.
 */
export function getScraperForHtml(html: string): BaseScraper {
  // ── MindBody detection ───────────────────────────────────
  // MindBody widgets inject a <script> whose src contains "healcode" or
  // "mindbodyonline.com", or a div with class "hc-widget".
  //
  // WHY check for these specific strings?
  // They are stable across MindBody's v5 and v6 embed APIs and appear even
  // when the gym has customised the widget's look and feel.
  if (
    html.includes('healcode') ||
    html.includes('mindbodyonline.com') ||
    html.includes('hc-widget')
  ) {
    // TODO: return new MindBodyScraper() once implemented.
    // For now, fall through to GenericScraper — it will still extract
    // schedule data from the rendered HTML, just less precisely.
  }

  // ── Glofox detection ─────────────────────────────────────
  // Glofox embeds typically contain "glofox" in script URLs or a
  // `data-glofox` attribute.
  if (html.includes('glofox')) {
    // TODO: return new GlofoxScraper() once implemented.
  }

  // ── Marianatek detection ─────────────────────────────────
  if (html.includes('marianatek') || html.includes('mariana-schedule')) {
    // TODO: return new MarianatekScraper() once implemented.
  }

  // ── Fallback: generic scraper ────────────────────────────
  // WHY always return *something* instead of throwing?
  // Even for unknown platforms the heuristic-based GenericScraper will
  // typically extract class names and times from tables / lists.  Partial
  // data is more useful than a hard failure.
  return new GenericScraper();
}
