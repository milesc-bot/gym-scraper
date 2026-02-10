/**
 * gymScanner.ts — The main orchestrator that ties every layer together.
 *
 * ARCHITECTURE OVERVIEW
 * ─────────────────────
 * GymScanner implements a five-stage pipeline:
 *
 *   1. FETCH   → StealthFetcher (via BrowserManager singleton)
 *   2. DETECT  → ScraperFactory picks the best parser for this page
 *   3. EXTRACT → The chosen scraper returns raw org / locations / classes
 *   4. NORMALISE → DateNormalizer converts "Monday 6PM" → UTC ISO
 *   5. PERSIST → SupabaseService bulk-upserts everything in 3 requests
 *
 * WHY this pipeline instead of one big function?
 * ──────────────────────────────────────────────
 * • **Testability:**  Each stage can be unit-tested in isolation.  You can
 *   feed HTML directly to a scraper without launching a browser, or test
 *   DateNormalizer without touching the database.
 * • **Swappability:**  Replacing the fetch layer (e.g. switching from
 *   Puppeteer to Playwright) or the database (Supabase → raw Postgres)
 *   only changes one stage.
 * • **Observability:**  Natural-language logs between stages make it easy
 *   to see exactly where a run succeeded or failed.
 *
 * WHY a singleton browser (BrowserManager)?
 * ─────────────────────────────────────────
 * Each Chromium process consumes 100–300 MB of RAM.  If the scraper processes
 * 50 gyms in a batch and launches a fresh browser each time, peak memory can
 * hit 10+ GB.  The singleton reuses one browser across all URLs and creates
 * lightweight incognito contexts (tabs) per request.  The withPage() API
 * guarantees cleanup even on errors, preventing "zombie browser" leaks.
 *
 * WHY batch upserts?
 * ──────────────────
 * Supabase (PostgREST + PgBouncer) has a limited connection pool.  Sending
 * 200 individual INSERT requests saturates the pool, triggers rate limiting,
 * and is 100× slower than a single bulk call.  SupabaseService.upsertClasses()
 * sends the entire array in ONE HTTP request.
 */

import { fetchWithStealth } from './middleware';
import { getScraperForHtml } from './scrapers';
import { normalizeDateTime } from './core/dateNormalizer';
import { SupabaseService } from './services/supabaseService';
import { BrowserManager } from './core/browserManager';
import { Logger } from './core/logger';
import type { ScanResult, GymClass, Location } from './core/types';

const logger = new Logger('GymScanner');

export class GymScanner {
  private supabase: SupabaseService;

  /**
   * @param supabaseService - Inject a SupabaseService (useful for tests).
   *   If omitted, a new one is created from environment variables.
   */
  constructor(supabaseService?: SupabaseService) {
    this.supabase = supabaseService ?? new SupabaseService();
  }

  /**
   * Scrape a single gym URL end-to-end and upsert the results.
   *
   * @param targetUrl - The gym's schedule page (e.g. "https://gym.com/schedule").
   * @param gymTimezone - IANA timezone for this gym (e.g. "America/New_York").
   *   Falls back to "UTC" if not provided.  Pass the correct zone to ensure
   *   DateNormalizer converts "6:00 PM" to the right UTC instant.
   *
   * @returns A summary of what was persisted (org ID, location IDs, class count).
   */
  async run(
    targetUrl: string,
    gymTimezone: string = 'UTC',
  ): Promise<ScanResult> {
    // ── Stage 1: FETCH ─────────────────────────────────────
    // WHY fetch first and pass HTML around (instead of passing a Page)?
    // Decoupling the browser from the scraper means we can unit-test scrapers
    // with static HTML fixtures — no Chromium required in CI.

    logger.info(`Starting scan for ${targetUrl}`);
    const html = await fetchWithStealth(targetUrl);

    // ── Stage 2: DETECT ────────────────────────────────────
    // The factory looks at DOM signatures (MindBody scripts, Glofox attrs,
    // etc.) and returns the most specialised scraper available.

    const scraper = getScraperForHtml(html);
    logger.info(`Selected scraper: ${scraper.constructor.name}`);

    // ── Stage 3: EXTRACT ───────────────────────────────────
    // The scraper returns raw data — class times are still local strings
    // like "Monday 6:00 PM", not UTC timestamps.

    const { organization, locations, classes } = await scraper.extract(
      html,
      targetUrl,
    );

    logger.info(
      `Extracted ${locations.length} location(s) and ${classes.length} class(es) ` +
        `for "${organization.name}"`,
    );

    // ── Stage 4: NORMALISE ─────────────────────────────────
    // Convert every raw time string to an absolute UTC ISO string.
    //
    // WHY do this in the orchestrator and not inside the scraper?
    // The scraper doesn't know the gym's timezone — that's a location-level
    // concern.  Keeping normalisation here means scrapers stay timezone-
    // agnostic and reusable.

    const locationsWithTimezone: Location[] = locations.map((loc) => ({
      ...loc,
      timezone: loc.timezone !== 'UTC' ? loc.timezone : gymTimezone,
    }));

    const normalizedClasses: GymClass[] = classes.map((cls) => ({
      ...cls,
      startTime: this.safeNormalize(cls.startTime, gymTimezone),
      endTime: cls.endTime
        ? this.safeNormalize(cls.endTime, gymTimezone)
        : undefined,
    }));

    // ── Stage 5: PERSIST ───────────────────────────────────
    // Upsert in parent → child order so FK references are valid.
    //
    // WHY three separate calls instead of one big transaction?
    // Supabase's REST API doesn't support multi-table transactions.  Upserting
    // in order (org → locations → classes) and using unique constraints on each
    // table gives us *practical* idempotency — a partial failure leaves the DB
    // in a consistent state and the next run fills in whatever was missed.

    logger.info(
      `Found ${normalizedClasses.length} classes for "${organization.name}", ` +
        `preparing batch upsert…`,
    );

    // 5a. Organization
    const orgId = await this.supabase.upsertOrganization(organization);

    // 5b. Locations — returns name → id map for FK linking.
    const locationMap = await this.supabase.upsertLocations(
      orgId,
      locationsWithTimezone,
    );

    // 5c. Classes — attach the correct location FK and send in ONE request.
    // WHY the default-to-first-location fallback?
    // If the scraper couldn't map a class to a specific location (single-
    // location gyms, or heuristics couldn't tell), we assign it to the first
    // location.  This is imperfect but prevents data loss — the operator can
    // correct location assignments in the dashboard.
    const defaultLocationId = [...locationMap.values()][0];
    const classesWithFks: GymClass[] = normalizedClasses.map((cls) => ({
      ...cls,
      locationId: cls.locationId ?? defaultLocationId,
    }));

    const upsertedCount = await this.supabase.upsertClasses(classesWithFks);

    logger.info(
      `Scan complete for "${organization.name}" — ` +
        `upserted ${upsertedCount} class(es) across ${locationMap.size} location(s)`,
    );

    return {
      organizationId: orgId,
      locationIds: [...locationMap.values()],
      classesUpserted: upsertedCount,
    };
  }

  // ── Helpers ──────────────────────────────────────────────

  /**
   * Attempt DateNormalizer; on failure, fall back to the raw string.
   *
   * WHY not just let it throw?
   * A single unparseable time (e.g. "TBA" or "Varies") should not abort
   * the entire batch.  We log a warning and keep the raw string — which
   * will likely fail the TIMESTAMPTZ cast in Supabase, giving the operator
   * a clear signal that manual attention is needed.
   */
  private safeNormalize(raw: string, timezone: string): string {
    try {
      return normalizeDateTime(raw, timezone);
    } catch {
      logger.warn(
        `Could not normalise time "${raw}" in timezone "${timezone}" — ` +
          `keeping raw value.  This may fail at database insert.`,
      );
      return raw;
    }
  }
}

// ─── CLI entry point ───────────────────────────────────────
// WHY a CLI wrapper?
// During development you want to test with a single URL without writing
// a script.  This block only runs when the file is executed directly
// (e.g. `ts-node src/gymScanner.ts https://example-gym.com/schedule`).

const isDirectRun = require.main === module;
if (isDirectRun) {
  const url = process.argv[2];
  const tz = process.argv[3] ?? 'UTC';

  if (!url) {
    console.error(
      'Usage: ts-node src/gymScanner.ts <URL> [IANA_TIMEZONE]\n' +
        'Example: ts-node src/gymScanner.ts https://gym.com/schedule America/New_York',
    );
    process.exit(1);
  }

  const scanner = new GymScanner();
  scanner
    .run(url, tz)
    .then((result) => {
      console.log('\n✓ Scan result:', JSON.stringify(result, null, 2));
    })
    .catch((err) => {
      console.error('\n✗ Scan failed:', err);
      process.exit(1);
    })
    .finally(async () => {
      // WHY close the browser explicitly here?
      // The process-exit hooks in BrowserManager handle SIGINT/SIGTERM, but
      // a normal exit via .then/.catch won't trigger them.  Closing manually
      // ensures Chromium shuts down cleanly.
      await BrowserManager.getInstance().close();
    });
}
