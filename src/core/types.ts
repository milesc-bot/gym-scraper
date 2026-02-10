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

// ─── Fetch result ──────────────────────────────────────────

/**
 * Extended fetch result returned by the refactored stealthFetcher.
 *
 * WHY return the Page + BrowserContext instead of just HTML?
 * The extraction validator (Section 6) needs to inspect live DOM state
 * (button states, pagination indicators) *after* scraping but *before*
 * the context is closed.  The caller is responsible for closing `context`
 * when done.
 */
export interface FetchResult {
  html: string;
  /** The live Puppeteer Page — only available when the browser path was used. */
  page?: import('puppeteer').Page;
  /** The BrowserContext that owns the page.  Caller MUST close this when done. */
  context?: import('puppeteer').BrowserContext;
  /** HTTP status code of the primary navigation. */
  statusCode?: number;
  /** Which fetch path was used. */
  fetchMethod: 'browser' | 'light';
}

// ─── Validator result ──────────────────────────────────────

/** Hints the validator can return to guide the orchestrator's retry strategy. */
export type RetryHint =
  | 'paginate-forward'   // "Next Day" button is active, more data exists
  | 'wait-longer'        // JS may not have finished rendering
  | 'switch-to-browser'  // Light fetch missed JS-rendered content
  | 're-authenticate';   // Page looks like a login wall

export interface ValidatorResult {
  valid: boolean;
  /** 0.0 – 1.0 confidence that the extraction is correct. */
  confidence: number;
  /** Human-readable descriptions of each check that ran. */
  signals: string[];
  /** If invalid, a hint for what the orchestrator should try differently. */
  retryHint?: RetryHint;
}

// ─── Navigation planner ────────────────────────────────────

/** Structured output from the LLM-powered navigation planner. */
export interface PlannerResult {
  /** CSS selector for the schedule container (table, list, grid). */
  scheduleSelector: string | null;
  /** CSS selector for the "next day/week" navigation button. */
  nextButtonSelector: string | null;
  /** CSS selector for any "load more" / pagination control. */
  loadMoreSelector: string | null;
  /** Whether the LLM detected a login/auth wall blocking content. */
  authWallDetected: boolean;
}

// ─── Session state ─────────────────────────────────────────

export type SessionState = 'logged-in' | 'logged-out' | 'unknown';

// ─── Day-worker API pattern ────────────────────────────────

/**
 * A discovered API pattern that the day-worker pool can replay
 * to fetch multiple days' schedules concurrently.
 */
export interface DayApiPattern {
  /** URL template with a `{{date}}` placeholder (e.g. "/api/schedule?date={{date}}"). */
  urlTemplate: string;
  method: 'GET' | 'POST';
  /** The query/body parameter name that carries the date value. */
  dateParam: string;
  /** For POST requests, the JSON body template with `{{date}}` placeholder. */
  bodyTemplate?: Record<string, unknown>;
  /** Headers captured from the original request (includes auth tokens, etc.). */
  headers: Record<string, string>;
}

// ─── Agent configuration ───────────────────────────────────

/**
 * Central configuration for all agent features.
 * Read from environment variables with sensible defaults.
 */
export interface AgentConfig {
  // Compliance
  botUserAgent: string;
  rateLimitMs: number;

  // LLM
  openaiApiKey?: string;
  llmBudgetCents: number;

  // Session
  gymUsername?: string;
  gymPassword?: string;
  gymTotpSecret?: string;
  cookieTtlHours: number;

  // Trap detection
  maxCrawlDepth: number;
}

/** Build an AgentConfig from process.env with defaults. */
export function loadAgentConfig(): AgentConfig {
  return {
    botUserAgent:
      process.env.BOT_USER_AGENT ??
      'MilesC-GymBot/1.0 (+http://your-site.com/bot)',
    rateLimitMs: parseInt(process.env.RATE_LIMIT_MS ?? '2000', 10),
    openaiApiKey: process.env.OPENAI_API_KEY,
    llmBudgetCents: parseInt(process.env.LLM_BUDGET_CENTS ?? '50', 10),
    gymUsername: process.env.GYM_USERNAME,
    gymPassword: process.env.GYM_PASSWORD,
    gymTotpSecret: process.env.GYM_TOTP_SECRET,
    cookieTtlHours: parseInt(process.env.COOKIE_TTL_HOURS ?? '24', 10),
    maxCrawlDepth: parseInt(process.env.MAX_CRAWL_DEPTH ?? '5', 10),
  };
}
