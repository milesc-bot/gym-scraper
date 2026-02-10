/**
 * genericScraper.ts — Concrete scraper for "standard" gym websites.
 *
 * WHY a "generic" scraper?
 * ────────────────────────
 * Most gym sites fall into one of a few widget patterns (tables, lists, grids).
 * Rather than writing a per-site scraper for each gym, the generic scraper uses
 * the heuristic helpers from BaseScraper to extract *whatever it can find*.
 * This lets the engine work on many gym sites out of the box.
 *
 * Later, when a specific platform (MindBody, Glofox, etc.) needs deeper parsing,
 * you create a dedicated scraper that extends BaseScraper and register it in the
 * factory.  The generic scraper remains the fallback for everything else.
 */

import * as cheerio from 'cheerio';
import { BaseScraper } from './baseScraper';
import type {
  ScrapeResult,
  Organization,
  Location,
  GymClass,
} from '../core/types';
import { Logger } from '../core/logger';

const logger = new Logger('GenericScraper');

export class GenericScraper extends BaseScraper {
  /**
   * Extract organization, locations, and classes from arbitrary gym HTML.
   *
   * The approach is intentionally *loose* — we'd rather return partial data
   * (which can be reviewed and corrected) than fail silently on an
   * unexpected layout.
   */
  async extract(html: string, url: string): Promise<ScrapeResult> {
    const $ = cheerio.load(html);

    // ── Organization ───────────────────────────────────────

    const orgName = this.extractOrganizationName($, url);
    const organization: Organization = {
      name: orgName,
      websiteUrl: url,
    };

    logger.info(`Identified organization: "${orgName}"`);

    // ── Locations ──────────────────────────────────────────

    const addresses = this.findAddresses($);
    const locations: Location[] = this.buildLocations(addresses, orgName);

    logger.info(`Found ${locations.length} location(s) for "${orgName}"`);

    // ── Classes ────────────────────────────────────────────

    const scheduleSnippets = this.findScheduleElements($);
    const classes: GymClass[] = this.buildClasses(scheduleSnippets);

    logger.info(`Found ${classes.length} class(es) for "${orgName}"`);

    return { organization, locations, classes };
  }

  // ── Private helpers ────────────────────────────────────

  /**
   * Turn address strings into Location objects.
   *
   * WHY default to a single "Main" location when no addresses are found?
   * Many single-location gyms don't list an address on their schedule page.
   * We still need *some* location row so classes have a parent FK.  Using a
   * placeholder name ("Main") is better than dropping all classes.
   */
  private buildLocations(addresses: string[], orgName: string): Location[] {
    if (addresses.length === 0) {
      return [
        {
          name: `${orgName} — Main`,
          timezone: 'UTC', // Will be refined when we know the gym's zone.
          address: undefined,
        },
      ];
    }

    return addresses.map((addr, idx) => ({
      name: addresses.length === 1 ? orgName : `${orgName} — Location ${idx + 1}`,
      address: addr,
      timezone: 'UTC', // Caller (GymScanner) should override with the real zone.
    }));
  }

  /**
   * Parse schedule snippets into GymClass shells.
   *
   * WHY leave `startTime` as a raw string here?
   * At this stage we only have the text the page showed (e.g. "Monday 6:00 PM").
   * DateNormalizer will convert it to UTC later, once the GymScanner knows the
   * location's timezone.  Keeping them as raw strings here keeps the scraper
   * timezone-agnostic — a good separation of concerns.
   *
   * WHY store the raw time in `startTime` temporarily?
   * GymScanner will overwrite it with the normalised UTC ISO string before
   * upserting.  This is a deliberate two-phase approach:
   *   Phase 1 (scraper): extract raw text → GymClass with raw `startTime`.
   *   Phase 2 (scanner): normalise `startTime` via DateNormalizer → UTC ISO.
   */
  private buildClasses(
    snippets: Array<{ text: string; dayContext?: string }>,
  ): GymClass[] {
    const classes: GymClass[] = [];

    for (const snippet of snippets) {
      const parsed = this.parseClassSnippet(snippet.text, snippet.dayContext);
      if (parsed) {
        classes.push(parsed);
      }
    }

    return classes;
  }

  /**
   * Attempt to extract a class name, time, and optional instructor from a
   * single text snippet.
   *
   * This is the *most heuristic* part of the system.  Real gym text varies
   * wildly:
   *   "Power Yoga  6:00 PM  Jane Doe"
   *   "Monday  HIIT 45  9AM - 9:45AM  w/ Coach Mike"
   *   "18:00  Spin Class"
   *
   * WHY a regex cascade instead of NLP?
   * A lightweight regex approach is fast, deterministic, and easy to debug.
   * NLP / LLM extraction can be layered on later for sites that defeat the
   * heuristics — but for 80 % of gym sites these patterns are sufficient.
   */
  private parseClassSnippet(
    text: string,
    dayContext?: string,
  ): GymClass | null {
    // Look for a time pattern anywhere in the snippet.
    const timeMatch = text.match(
      /(\d{1,2}(?::\d{2})?\s*(?:AM|PM|am|pm))/,
    );

    if (!timeMatch) return null;

    const rawTime = timeMatch[1];

    // Everything *before* the time is likely the class name.
    const beforeTime = text.substring(0, timeMatch.index).trim();
    // Everything *after* the time might contain instructor or duration.
    const afterTime = text
      .substring((timeMatch.index ?? 0) + rawTime.length)
      .trim();

    // Try to extract an end time from afterTime (e.g. "- 7:00 PM").
    const endTimeMatch = afterTime.match(
      /[-–—]\s*(\d{1,2}(?::\d{2})?\s*(?:AM|PM|am|pm))/i,
    );
    const rawEndTime = endTimeMatch ? endTimeMatch[1] : undefined;

    // Try to find an instructor (common patterns: "w/ Name", "with Name",
    // or just a capitalised name after the time).
    const instructorMatch = afterTime.match(
      /(?:w\/|with)\s+([A-Z][\w\s]+)/i,
    );
    const instructor = instructorMatch ? instructorMatch[1].trim() : undefined;

    // Build the raw time string that DateNormalizer expects.
    // If we have a day context (e.g. "Monday") prepend it.
    const dayPrefix =
      dayContext ??
      (() => {
        const dayMatch = beforeTime.match(
          /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|today|tomorrow)\b/i,
        );
        return dayMatch ? dayMatch[1] : undefined;
      })();

    const rawStartTime = dayPrefix
      ? `${dayPrefix} ${rawTime}`
      : rawTime;

    const rawEndTimeFull =
      rawEndTime && dayPrefix
        ? `${dayPrefix} ${rawEndTime}`
        : rawEndTime;

    // Derive the class name from the text before the time, stripping any
    // day name we already extracted.
    let className = beforeTime
      .replace(
        /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|today|tomorrow)\b/gi,
        '',
      )
      .trim();

    // If nothing is left, try the text after the time (some sites put the
    // name *after* the time).
    if (!className) {
      className = afterTime
        .replace(/[-–—]\s*\d{1,2}(?::\d{2})?\s*(?:AM|PM|am|pm)/i, '')
        .replace(/(?:w\/|with)\s+[\w\s]+/i, '')
        .trim();
    }

    if (!className) className = 'Unknown Class';

    return {
      name: className,
      startTime: rawStartTime,
      endTime: rawEndTimeFull,
      instructor,
    };
  }
}
