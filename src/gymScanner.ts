/**
 * gymScanner.ts — The main orchestrator: an autonomous gym scraping agent.
 *
 * ARCHITECTURE OVERVIEW
 * ─────────────────────
 * GymScanner implements a nine-stage pipeline:
 *
 *   1. COMPLIANCE   → robots.txt check, rate limiting, User-Agent
 *   2. TRAP GUARD   → URL pattern analysis, depth tracking
 *   3. FETCH        → Light HTTP (got-scraping) → fallback to Puppeteer
 *   4. PLAN         → LLM navigation planner (if interaction needed)
 *   5. EXTRACT      → Scraper factory picks the best parser
 *   6. VALIDATE     → Proof-by-validation (cross-reference secondary signals)
 *   7. NORMALISE    → DateNormalizer converts "Monday 6PM" → UTC ISO
 *   8. PERSIST      → SupabaseService bulk-upserts everything
 *   9. PARALLEL     → Day-worker pool for concurrent multi-day extraction
 *
 * NEW CAPABILITIES
 * ────────────────
 * • Light-fetch → browser fallback with TLS fingerprint diversity
 * • Fingerprint noise injection (Canvas/WebGL/AudioContext)
 * • Human-like idle behaviour (ghost-cursor mouse + scroll)
 * • Extraction validation with retry-on-failure
 * • LLM-powered navigation planning (self-healing selectors)
 * • Session management with login agent + TOTP 2FA
 * • Parallel day-worker extraction via API pattern discovery
 * • Trap detection for AI labyrinth avoidance
 */

import { fetchWithStealth } from './middleware/stealthFetcher';
import { getScraperForHtml } from './scrapers';
import { normalizeDateTime } from './core/dateNormalizer';
import { SupabaseService } from './services/supabaseService';
import { BrowserManager } from './core/browserManager';
import { Logger } from './core/logger';
import { TrapDetector } from './middleware/trapDetector';
import { validateExtraction } from './middleware/extractionValidator';
import { planNavigation } from './agents/navigationPlanner';
import { waitForSession, checkForLoginWall } from './agents/sessionManager';
import {
  setupRequestCapture,
  analyseInterceptedRequests,
  fetchWeekParallel,
} from './agents/dayWorkerPool';
import { humanClick, createHumanCursor, humanScroll } from './middleware/humanBehavior';
import type {
  ScanResult,
  GymClass,
  Location,
  FetchResult,
  AgentConfig,
  ScrapeResult,
} from './core/types';
import { loadAgentConfig } from './core/types';

const logger = new Logger('GymScanner');

export class GymScanner {
  private supabase: SupabaseService;
  private trapDetector: TrapDetector;
  private config: AgentConfig;

  constructor(supabaseService?: SupabaseService) {
    this.supabase = supabaseService ?? new SupabaseService();
    this.config = loadAgentConfig();
    this.trapDetector = new TrapDetector(this.config.maxCrawlDepth);
  }

  /**
   * Scrape a single gym URL end-to-end and upsert the results.
   *
   * This is the main entry point that orchestrates all nine stages.
   */
  async run(
    targetUrl: string,
    gymTimezone: string = 'UTC',
  ): Promise<ScanResult> {
    logger.info(`Starting autonomous scan for ${targetUrl}`);

    // ── Stage 1: COMPLIANCE ─────────────────────────────────
    // robots.txt and rate limiting are handled inside fetchWithStealth(),
    // but we log the intent here for observability.
    logger.info('Stage 1 (Compliance): Checking robots.txt and rate limits…');

    // ── Stage 2: TRAP GUARD ─────────────────────────────────
    logger.info('Stage 2 (Trap Guard): Analysing URL pattern…');
    const trapCheck = this.trapDetector.checkUrl(targetUrl);
    if (!trapCheck.safe) {
      logger.warn(`Trap detected: ${trapCheck.reason} — aborting`);
      throw new Error(`Trap detected for ${targetUrl}: ${trapCheck.reason}`);
    }

    // ── Stage 3: FETCH ──────────────────────────────────────
    logger.info('Stage 3 (Fetch): Fetching page…');

    // Ensure session is healthy before fetching.
    await waitForSession();

    let fetchResult: FetchResult;
    try {
      fetchResult = await fetchWithStealth(targetUrl);
    } catch (err) {
      logger.error(`Fetch failed for ${targetUrl}`, err);
      throw err;
    }

    // Handle empty / blocked responses.
    if (!fetchResult.html) {
      if (fetchResult.statusCode === 402) {
        throw new Error(
          `Pay-to-Crawl firewall (HTTP 402) at ${targetUrl}. ` +
            `This site requires a paid crawling agreement.`,
        );
      }
      throw new Error(`Empty response from ${targetUrl} (HTTP ${fetchResult.statusCode})`);
    }

    // ── Stage 4: PLAN (if interaction needed) ───────────────
    let planUsed = false;
    if (fetchResult.page && this.config.openaiApiKey) {
      logger.info('Stage 4 (Plan): Running navigation planner…');
      try {
        const plan = await planNavigation(fetchResult.page, this.config);

        // If an auth wall was detected, let the session manager handle it.
        if (plan.authWallDetected) {
          logger.warn('Navigation planner detected auth wall');
          if (fetchResult.page) {
            await checkForLoginWall(fetchResult.page, this.config);
            // Wait for re-authentication.
            await waitForSession();
            // Re-fetch after login.
            if (fetchResult.context) {
              await fetchResult.context.close().catch(() => {});
            }
            fetchResult = await fetchWithStealth(targetUrl, { forceBrowser: true });
          }
        }

        // If a "load more" button was found, click it.
        if (plan.loadMoreSelector && fetchResult.page) {
          logger.info(`Clicking "Load More" (${plan.loadMoreSelector})…`);
          try {
            const cursor = createHumanCursor(fetchResult.page);
            await humanClick(cursor, plan.loadMoreSelector);
            await fetchResult.page.waitForNetworkIdle({ timeout: 5_000 }).catch(() => {});
            // Re-capture HTML after loading more content.
            fetchResult.html = await fetchResult.page.content();
            planUsed = true;
          } catch {
            logger.warn('Failed to click "Load More" — proceeding with current content');
          }
        }
      } catch (err) {
        logger.warn(`Navigation planner error (non-fatal): ${(err as Error).message}`);
      }
    } else {
      logger.info('Stage 4 (Plan): Skipped (no live page or no OpenAI key)');
    }

    // ── Stage 5: EXTRACT ────────────────────────────────────
    logger.info('Stage 5 (Extract): Running scraper factory…');
    const scraper = getScraperForHtml(fetchResult.html);
    logger.info(`Selected scraper: ${scraper.constructor.name}`);

    let scrapeResult: ScrapeResult;
    try {
      scrapeResult = await scraper.extract(fetchResult.html, targetUrl);
    } catch (err) {
      // Clean up browser context if open.
      if (fetchResult.context) {
        await fetchResult.context.close().catch(() => {});
      }
      throw err;
    }

    const { organization, locations, classes } = scrapeResult;

    logger.info(
      `Extracted ${locations.length} location(s) and ${classes.length} class(es) ` +
        `for "${organization.name}"`,
    );

    // ── Stage 6: VALIDATE ───────────────────────────────────
    logger.info('Stage 6 (Validate): Proof-by-validation…');
    const validation = await validateExtraction(
      scrapeResult,
      fetchResult.page,
      fetchResult.html,
    );

    // Close the browser context now that validation is done.
    if (fetchResult.context) {
      await fetchResult.context.close().catch(() => {});
    }

    // Handle validation failure with retry.
    if (!validation.valid && validation.retryHint) {
      logger.warn(
        `Validation failed (confidence: ${validation.confidence.toFixed(2)}). ` +
          `Retrying with hint: ${validation.retryHint}`,
      );

      const retryResult = await this.retryWithHint(
        targetUrl,
        gymTimezone,
        validation.retryHint,
      );
      if (retryResult) {
        return retryResult;
      }
      // If retry also failed, proceed with whatever we have.
      logger.warn('Retry also produced low-confidence results — proceeding anyway');
    }

    // Post-extraction trap check (content quality).
    const bodyText = fetchResult.html.replace(/<[^>]+>/g, ' ');
    const contentTrap = this.trapDetector.checkContent(
      targetUrl,
      bodyText,
      classes.length,
    );
    if (!contentTrap.safe) {
      logger.warn(`Content trap detected: ${contentTrap.reason}`);
      // Don't abort — log the warning and proceed.  The operator can
      // review the data quality in the dashboard.
    }

    // ── Stage 7: NORMALISE ──────────────────────────────────
    logger.info('Stage 7 (Normalise): Converting times to UTC…');

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

    // ── Stage 8: PERSIST ────────────────────────────────────
    logger.info(
      `Stage 8 (Persist): Upserting ${normalizedClasses.length} classes for "${organization.name}"…`,
    );

    // 8a. Organization
    const orgId = await this.supabase.upsertOrganization(organization);

    // 8b. Locations
    const locationMap = await this.supabase.upsertLocations(
      orgId,
      locationsWithTimezone,
    );

    // 8c. Classes
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

    // ── Stage 9: PARALLEL (optional) ────────────────────────
    // If the initial fetch used the browser path and we captured API patterns,
    // try to fetch remaining days in parallel.
    // Note: This is a future enhancement — the current single-URL flow
    // doesn't inherently need multi-day fetching, but the infrastructure
    // is ready for when batch scheduling is added.

    return {
      organizationId: orgId,
      locationIds: [...locationMap.values()],
      classesUpserted: upsertedCount,
    };
  }

  // ── Retry logic ──────────────────────────────────────────

  /**
   * Retry a failed extraction using the validator's hint.
   *
   * WHY only one retry?
   * Each retry is expensive (full browser + potential LLM call).
   * One targeted retry based on the hint is usually enough; if it
   * also fails, the data quality is genuinely poor and further
   * retries won't help.
   */
  private async retryWithHint(
    url: string,
    timezone: string,
    hint: string,
  ): Promise<ScanResult | null> {
    logger.info(`Retry strategy: ${hint}`);

    try {
      switch (hint) {
        case 'switch-to-browser':
          // The light fetch missed JS content — force browser.
          return await this.runWithOptions(url, timezone, { forceBrowser: true });

        case 'wait-longer':
          // JS might not have finished — use browser with extra wait.
          return await this.runWithOptions(url, timezone, {
            forceBrowser: true,
            extraWaitMs: 5_000,
          });

        case 'paginate-forward':
          // Partial data — try clicking "Next" via the planner.
          // This is a simplified retry; full pagination would be
          // handled by the day-worker pool.
          return await this.runWithOptions(url, timezone, { forceBrowser: true });

        case 're-authenticate':
          // Auth wall — the session manager should have been triggered
          // already, but try again with a fresh session.
          return await this.runWithOptions(url, timezone, { forceBrowser: true });

        default:
          logger.warn(`Unknown retry hint: ${hint}`);
          return null;
      }
    } catch (err) {
      logger.error(`Retry failed for ${url}`, err);
      return null;
    }
  }

  /**
   * Internal: re-run the pipeline with specific options.
   * Used by the retry logic to avoid infinite recursion.
   */
  private async runWithOptions(
    url: string,
    timezone: string,
    options: { forceBrowser?: boolean; extraWaitMs?: number },
  ): Promise<ScanResult> {
    const fetchResult = await fetchWithStealth(url, {
      forceBrowser: options.forceBrowser,
    });

    if (options.extraWaitMs && fetchResult.page) {
      await fetchResult.page.evaluate(
        (ms: number) => new Promise((r) => setTimeout(r, ms)),
        options.extraWaitMs,
      );
      fetchResult.html = await fetchResult.page.content();
    }

    const scraper = getScraperForHtml(fetchResult.html);
    const { organization, locations, classes } = await scraper.extract(
      fetchResult.html,
      url,
    );

    // Close browser context.
    if (fetchResult.context) {
      await fetchResult.context.close().catch(() => {});
    }

    const locationsWithTimezone: Location[] = locations.map((loc) => ({
      ...loc,
      timezone: loc.timezone !== 'UTC' ? loc.timezone : timezone,
    }));

    const normalizedClasses: GymClass[] = classes.map((cls) => ({
      ...cls,
      startTime: this.safeNormalize(cls.startTime, timezone),
      endTime: cls.endTime ? this.safeNormalize(cls.endTime, timezone) : undefined,
    }));

    const orgId = await this.supabase.upsertOrganization(organization);
    const locationMap = await this.supabase.upsertLocations(
      orgId,
      locationsWithTimezone,
    );

    const defaultLocationId = [...locationMap.values()][0];
    const classesWithFks: GymClass[] = normalizedClasses.map((cls) => ({
      ...cls,
      locationId: cls.locationId ?? defaultLocationId,
    }));

    const upsertedCount = await this.supabase.upsertClasses(classesWithFks);

    return {
      organizationId: orgId,
      locationIds: [...locationMap.values()],
      classesUpserted: upsertedCount,
    };
  }

  // ── Helpers ──────────────────────────────────────────────

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
      await BrowserManager.getInstance().close();
    });
}
