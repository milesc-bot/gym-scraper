/**
 * types.ts — Shared type definitions for the entire scraping pipeline.
 *
 * WHY a single types file?
 * ────────────────────────
 * Every layer (scrapers, services, the orchestrator) must agree on the shape of
 * the data flowing through the system.  Centralising types here means:
 *   • TypeScript catches mismatches at compile time instead of at 2 AM in production.
 *   • Adding a field (e.g. `spots_open`) is a one-file change that propagates everywhere.
 *   • Supabase row shapes and scraper output share the same source of truth.
 */

// ─── Organization ──────────────────────────────────────────

/** A gym brand / company – the top-level entity we scrape. */
export interface Organization {
  /** Supabase-generated UUID.  Undefined until the row is persisted. */
  id?: string;
  /** Human-readable gym name (e.g. "SoulCycle"). */
  name: string;
  /** The root URL we scraped (used as an idempotency anchor for upserts). */
  websiteUrl: string;
}

// ─── Location ──────────────────────────────────────────────

/**
 * A physical studio / branch within an organization.
 *
 * WHY store `timezone`?
 * Gym sites display times like "6:00 PM" without any offset.  We need the
 * location's IANA timezone (e.g. "America/New_York") so DateNormalizer can
 * convert that to an absolute TIMESTAMPTZ before writing to Supabase.
 */
export interface Location {
  id?: string;
  /** FK → organizations.id.  Set after upserting the parent organization. */
  organizationId?: string;
  /** Branch / studio name (e.g. "Downtown Manhattan"). */
  name: string;
  /** Street address, if found on the page. */
  address?: string;
  /**
   * IANA timezone identifier (e.g. "America/New_York").
   * Defaults to "UTC" in the DB if we cannot determine it.
   */
  timezone: string;
}

// ─── GymClass ──────────────────────────────────────────────

/**
 * A single scheduled class at a location.
 *
 * WHY TIMESTAMPTZ (ISO string) for times instead of a bare "6:00 PM" string?
 * Storing absolute UTC timestamps means:
 *   • The composite unique key (location_id, start_time, name) is truly unique —
 *     "Monday 6pm" and "Tuesday 6pm" are distinct rows.
 *   • Consumers (dashboards, APIs) never have to guess which day "Monday" meant.
 */
export interface GymClass {
  id?: string;
  /** FK → locations.id.  Set after upserting the parent location. */
  locationId?: string;
  /** Class title (e.g. "Power Yoga", "HIIT 45"). */
  name: string;
  /** Absolute UTC start time as an ISO-8601 string (e.g. "2026-02-10T23:00:00.000Z"). */
  startTime: string;
  /** Absolute UTC end time.  Nullable because many sites omit it. */
  endTime?: string;
  /** Instructor name, if listed. */
  instructor?: string;
  /** Total available spots, if listed. */
  spotsTotal?: number;
}

// ─── Scraper result ────────────────────────────────────────

/**
 * The unified shape every scraper must return.
 *
 * WHY a single object instead of three separate arrays?
 * Keeping them together preserves the parent → child relationships so
 * GymScanner can upsert in the correct order (org → locations → classes)
 * without juggling separate variables.
 */
export interface ScrapeResult {
  organization: Organization;
  locations: Location[];
  classes: GymClass[];
}

// ─── Scanner result ────────────────────────────────────────

/** What GymScanner.run() resolves with so callers can act on the outcome. */
export interface ScanResult {
  organizationId: string;
  locationIds: string[];
  classesUpserted: number;
}
