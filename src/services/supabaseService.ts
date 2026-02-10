/**
 * supabaseService.ts — Database access layer with idempotent BATCH upserts.
 *
 * WHY a dedicated service class?
 * ──────────────────────────────
 * 1. **Single responsibility:**  All Supabase calls live here.  Scrapers and
 *    the orchestrator never import `@supabase/supabase-js` directly, so
 *    swapping databases later is a one-file change.
 * 2. **Batch-first design:**  Every write method accepts an *array* and sends
 *    it in ONE HTTP request.  This is critical because:
 *    • Supabase's PostgREST layer allows ~1 000 rows per request comfortably.
 *    • Sending 200 individual INSERT requests burns through the connection pool,
 *      triggers rate-limiting, and takes 10–50× longer than a single bulk call.
 * 3. **Idempotency:**  Each method uses `upsert` with `onConflict` pointing at
 *    the relevant unique constraint.  Running the scraper twice on the same gym
 *    updates existing rows instead of creating duplicates.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Logger } from '../core/logger';
import type { Organization, Location, GymClass } from '../core/types';

const logger = new Logger('SupabaseService');

export class SupabaseService {
  private client: SupabaseClient;

  /**
   * @param client - An existing Supabase client, OR `undefined` to build one
   *   from environment variables (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).
   *
   * WHY accept an optional client?
   * In production you create the client once (from env vars).  In tests you
   * can inject a mock client without touching the environment.
   */
  constructor(client?: SupabaseClient) {
    if (client) {
      this.client = client;
    } else {
      const url = process.env.SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

      if (!url || !key) {
        throw new Error(
          'SupabaseService: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be ' +
            'set in the environment.  See .env.example.',
        );
      }

      // WHY service-role key instead of anon key?
      // The scraper writes to tables that should *not* be writable by anonymous
      // users.  The service-role key bypasses RLS so the scraper can INSERT /
      // UPDATE freely while end-users are still locked down.
      this.client = createClient(url, key);
    }
  }

  // ── Organizations ────────────────────────────────────────

  /**
   * Insert or update an organization, keyed by `website_url`.
   *
   * WHY upsert on `website_url`?
   * The same gym URL should always map to exactly one organization row.
   * If the gym renames itself we want to update the existing row's `name`,
   * not create a second row.
   *
   * @returns The organization's UUID (from the DB, whether inserted or updated).
   */
  async upsertOrganization(org: Organization): Promise<string> {
    const { data, error } = await this.client
      .from('organizations')
      .upsert(
        {
          name: org.name,
          website_url: org.websiteUrl,
          updated_at: new Date().toISOString(),
        },
        {
          // WHY onConflict here?
          // `website_url` has a UNIQUE constraint.  If a row with the same URL
          // already exists, Supabase (PostgREST) will UPDATE it instead of
          // INSERTing a duplicate.
          onConflict: 'website_url',
          ignoreDuplicates: false,
        },
      )
      .select('id')
      .single();

    if (error) {
      throw new Error(
        `SupabaseService.upsertOrganization failed: ${error.message}`,
      );
    }

    logger.info(`Upserted organization "${org.name}" → ${data.id}`);
    return data.id;
  }

  // ── Locations ────────────────────────────────────────────

  /**
   * Bulk-upsert locations for an organization.
   *
   * WHY batch?
   * A gym chain with 20 studios should produce 1 HTTP request, not 20.
   *
   * @returns A map of location name → UUID so callers can attach classes to
   *   the correct location without a second round-trip.
   */
  async upsertLocations(
    organizationId: string,
    locations: Location[],
  ): Promise<Map<string, string>> {
    if (locations.length === 0) return new Map();

    const rows = locations.map((loc) => ({
      organization_id: organizationId,
      name: loc.name,
      address: loc.address ?? null,
      timezone: loc.timezone,
      updated_at: new Date().toISOString(),
    }));

    // WHY onConflict: 'organization_id,name'?
    // The UNIQUE constraint `locations_org_name_key` covers these two columns.
    // If a branch already exists for this org under the same name, we update
    // its address / timezone instead of inserting a duplicate.
    const { data, error } = await this.client
      .from('locations')
      .upsert(rows, {
        onConflict: 'organization_id,name',
        ignoreDuplicates: false,
      })
      .select('id, name');

    if (error) {
      throw new Error(
        `SupabaseService.upsertLocations failed: ${error.message}`,
      );
    }

    const nameToId = new Map<string, string>();
    for (const row of data) {
      nameToId.set(row.name, row.id);
    }

    logger.info(
      `Upserted ${data.length} location(s) for organization ${organizationId}`,
    );
    return nameToId;
  }

  // ── Classes ──────────────────────────────────────────────

  /**
   * Bulk-upsert classes in a SINGLE HTTP request.
   *
   * THIS IS THE MOST PERFORMANCE-CRITICAL METHOD IN THE SERVICE.
   *
   * WHY one request for the entire array?
   * ─────────────────────────────────────
   * • **Connection pool:**  Supabase's pooler (PgBouncer) has a limited number
   *   of server connections.  Sending 200 individual upserts means 200 round-
   *   trips through the pool — each one acquires a connection, runs the query,
   *   and releases it.  Under load this saturates the pool and queues requests.
   *   A single bulk upsert uses ONE connection for all 200 rows.
   *
   * • **Rate limits:**  Supabase applies per-second request limits.  Batching
   *   means we count as 1 request regardless of row count.
   *
   * • **Latency:**  200 sequential HTTP round-trips at ~50 ms each = 10 seconds.
   *   One bulk call = ~100 ms.  That is a 100× improvement.
   *
   * WHY `ignoreDuplicates: false`?
   * We *want* to update the row when the scraper finds new data for an existing
   * class (e.g. the instructor changed, or spots_total was updated).  Setting
   * `ignoreDuplicates: true` would silently skip those updates.
   *
   * @param classes - Full array of classes to upsert.  Each must have
   *   `locationId` and `startTime` already set (see DateNormalizer).
   * @returns The number of rows affected (inserted + updated).
   */
  async upsertClasses(classes: GymClass[]): Promise<number> {
    if (classes.length === 0) return 0;

    // Map from our camelCase interface to the snake_case DB columns.
    // WHY map here instead of using camelCase columns in the DB?
    // PostgreSQL convention is snake_case.  Keeping the DB idiomatic means
    // raw SQL, Supabase dashboard views, and other clients all look natural.
    // The mapping cost is negligible compared to the HTTP round-trip.
    const rows = classes.map((c) => ({
      location_id: c.locationId,
      name: c.name,
      start_time: c.startTime,
      end_time: c.endTime ?? null,
      instructor: c.instructor ?? null,
      spots_total: c.spotsTotal ?? null,
      updated_at: new Date().toISOString(),
    }));

    const { data, error } = await this.client
      .from('classes')
      .upsert(rows, {
        // WHY this specific onConflict value?
        // It matches the `classes_dedupe_key` UNIQUE constraint defined in the
        // migration.  PostgREST uses these columns to detect existing rows and
        // decide whether to INSERT or UPDATE.
        onConflict: 'location_id,start_time,name',
        ignoreDuplicates: false,
      })
      .select('id');

    if (error) {
      throw new Error(
        `SupabaseService.upsertClasses failed: ${error.message}`,
      );
    }

    const count = data.length;
    logger.info(`Upserted ${count} class(es) in a single batch request`);
    return count;
  }
}
