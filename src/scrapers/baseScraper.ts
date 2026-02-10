/**
 * baseScraper.ts — Abstract base class + heuristic helpers for gym scrapers.
 *
 * WHY an abstract class instead of a plain interface?
 * ───────────────────────────────────────────────────
 * 1. **Shared heuristics:**  Every concrete scraper needs the same address-
 *    detection regex, time-pattern matcher, and org-name extractor.  Putting
 *    them on a base class means GenericScraper, MindBodyScraper, etc. inherit
 *    them for free — no code duplication.
 * 2. **Enforced contract:**  The abstract `extract()` method guarantees every
 *    scraper returns a `ScrapeResult` with the same shape.  TypeScript will
 *    refuse to compile a subclass that forgets to implement it.
 * 3. **Extensibility:**  Adding a new gym-platform scraper is "extend
 *    BaseScraper, implement extract()" — the heuristics, logging, and type
 *    safety come along for the ride.
 */

import * as cheerio from 'cheerio';
import type { ScrapeResult } from '../core/types';

export abstract class BaseScraper {
  /**
   * Parse `html` from `url` and return structured gym data.
   *
   * Every concrete scraper MUST implement this.  The orchestrator
   * (GymScanner) calls it after fetching the page and selecting the
   * right scraper via the factory.
   */
  abstract extract(html: string, url: string): Promise<ScrapeResult>;

  // ── Heuristic helpers (shared by all scrapers) ─────────

  /**
   * Derive an organization name from common HTML meta tags or the URL.
   *
   * WHY multiple fallbacks?
   * Not every gym site sets `og:site_name`.  Some only have a `<title>`.
   * Others have neither — in that case we fall back to the hostname, which
   * is always available and usually contains the brand name (e.g.
   * "soulcycle.com" → "soulcycle.com").
   */
  protected extractOrganizationName(
    $: cheerio.CheerioAPI,
    url: string,
  ): string {
    // 1. Open Graph site name — most reliable when present.
    const ogName = $('meta[property="og:site_name"]').attr('content')?.trim();
    if (ogName) return ogName;

    // 2. <title> tag — strip common suffixes like " | Home" or " - Schedule".
    const title = $('title').text().trim();
    if (title) {
      return title.split(/\s*[|\-–—]\s*/)[0].trim();
    }

    // 3. Hostname as last resort.
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }

  /**
   * Search the DOM for elements that look like physical addresses.
   *
   * WHY a heuristic instead of a fixed CSS selector?
   * ─────────────────────────────────────────────────
   * Gym sites have no standard markup for addresses.  Some use
   * `<address>`, others use `<div class="location-address">`, and many
   * just dump text into a generic `<p>`.  A regex that matches US-style
   * patterns ("123 Main St", "Suite 200", ZIP codes) catches most of them
   * regardless of the DOM structure.
   */
  protected findAddresses($: cheerio.CheerioAPI): string[] {
    const addresses: string[] = [];

    // Pattern: a number followed by words, optionally with a 5-digit ZIP.
    // Intentionally loose — false positives are better than missing a real
    // address, because the worst case is an extra location that gets
    // deduplicated on the next run.
    const addressRegex =
      /\d{1,5}\s+[\w\s.]+(?:st(?:reet)?|ave(?:nue)?|blvd|dr(?:ive)?|rd|ln|ct|way|pl(?:ace)?|pkwy)[\w\s,.#-]*\d{5}/gi;

    // Check <address> tags first — they are semantically correct when present.
    $('address').each((_, el) => {
      const text = $(el).text().trim();
      if (text.length > 5) addresses.push(text);
    });

    // Fall back to a full-text search if no <address> tags found.
    if (addresses.length === 0) {
      const bodyText = $('body').text();
      const matches = bodyText.match(addressRegex);
      if (matches) {
        addresses.push(...matches.map((m) => m.trim()));
      }
    }

    return [...new Set(addresses)]; // deduplicate
  }

  /**
   * Find DOM elements that contain time-like patterns (e.g. "6:00 PM").
   *
   * Returns raw text snippets — the caller (concrete scraper) is responsible
   * for further parsing (splitting class name from time, etc.).
   *
   * WHY look for multiple patterns?
   * Gym sites use:
   *   • 12-hour with colon:  "6:00 PM"
   *   • 12-hour no colon:    "6PM"
   *   • 24-hour:             "18:00"
   *   • Ranges:              "6:00 PM - 7:00 PM"
   * A single regex with alternation catches all of these.
   */
  protected findScheduleElements(
    $: cheerio.CheerioAPI,
  ): Array<{ text: string; dayContext?: string }> {
    const results: Array<{ text: string; dayContext?: string }> = [];
    const timeRegex = /\d{1,2}(?::\d{2})?\s*(?:AM|PM|am|pm)/;

    const dayNames =
      /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|today|tomorrow)\b/i;

    // WHY scan table rows AND list items AND generic divs?
    // Schedule widgets appear as <table>, <ul>, or plain <div> grids
    // depending on the platform.  Casting a wide net here means the
    // concrete scraper doesn't have to know which widget was used.

    // Strategy 1: Table rows — very common for MindBody embeds.
    $('table tr').each((_, row) => {
      const text = $(row).text().trim();
      if (timeRegex.test(text)) {
        results.push({ text });
      }
    });

    // Strategy 2: List items — used by some React-based schedule widgets.
    if (results.length === 0) {
      $('li, [class*="class"], [class*="schedule"], [class*="event"]').each(
        (_, el) => {
          const text = $(el).text().trim();
          if (timeRegex.test(text)) {
            const dayMatch = text.match(dayNames);
            results.push({
              text,
              dayContext: dayMatch ? dayMatch[1] : undefined,
            });
          }
        },
      );
    }

    // Strategy 3: Any element with time-like text (broadest net).
    if (results.length === 0) {
      $('div, span, p').each((_, el) => {
        const text = $(el).text().trim();
        // Only grab "leaf" elements (avoid duplicating parent + child text).
        if (
          text.length < 200 &&
          timeRegex.test(text) &&
          $(el).children().length < 3
        ) {
          const dayMatch = text.match(dayNames);
          results.push({
            text,
            dayContext: dayMatch ? dayMatch[1] : undefined,
          });
        }
      });
    }

    return results;
  }
}
