# Autonomous Gym Scraper Agent

A production-grade autonomous web scraping agent that extracts gym schedules, locations, and class data from defensive websites and upserts the results into a Supabase (PostgreSQL) database.

Built to defeat modern anti-bot defences: TLS fingerprint analysis (JA4+), browser fingerprinting (Canvas/WebGL/AudioContext), behavioural biometrics, AI labyrinth traps, and login walls with 2FA.

## Features

### Stealth Layer (Anti-Detection)

- **TLS fingerprint hardening** — Dual fetch paths: `got-scraping` impersonates Chrome 130+ at the TLS level (defeating JA4+ signatures), with automatic fallback to full Puppeteer for JS-rendered pages.
- **Browser fingerprint noise** — Injects per-session Canvas, WebGL, and AudioContext noise via `evaluateOnNewDocument` with `toString()` restoration to survive active runtime probing.
- **Human-like behaviour** — `ghost-cursor` provides Bezier curve mouse movements with overshoot, Fitts's Law timing, and stochastic jitter. Custom scroll and typing simulations with Gaussian-distributed inter-key delays.
- **AI labyrinth defence** — Detects recursive trap pages via URL entropy analysis, content hash deduplication, information density scoring, and configurable depth limits.
- **Compliance hooks** — Transparent User-Agent, robots.txt checking, HTTP 402 (Pay-to-Crawl) handling, and per-domain rate limiting via Bottleneck with burst support.

### Intelligence Layer (Autonomous Agent)

- **Proof-by-validation** — Cross-references extracted data against secondary page signals (pagination button states, class count plausibility, content coherence, auth wall detection). Retries with a different strategy on failure.
- **LLM navigation planner** — Dumps the accessibility tree and asks `gpt-4o-mini` to identify interactive elements (schedule containers, "Next Day" buttons, login forms). Self-healing: if a selector breaks, the planner re-analyses.
- **Session management** — Monitors for logged-out state (HTTP 401/403, `/login` redirects, password fields). Pauses all operations, triggers a Login Agent that types credentials with human-like timing, handles TOTP 2FA via `otplib`, and persists cookies for the next run.
- **Parallel day-workers** — Intercepts XHR/fetch requests to discover date-parameterised API patterns, then fetches all 7 days concurrently via `got-scraping` through a Bottleneck rate limiter. Falls back to sequential Navigation Planner clicks if no API pattern is found.

### Core Engine

- **Singleton browser** — One Chromium instance, many lightweight incognito tabs. No zombie browsers, no RAM leaks.
- **Timezone-aware date normalisation** — "Monday 6:00 PM" is converted to an absolute UTC timestamp using the gym's IANA timezone.
- **Idempotent batch upserts** — Running the scraper twice on the same URL updates existing rows instead of creating duplicates. All classes are sent in a single HTTP request per batch.
- **Pluggable scraper factory** — Automatically detects MindBody, Glofox, or generic HTML and routes to the best parser. Adding a new platform is a two-file change.

## Before you push to GitHub

- **Never commit `.env`** — it is in `.gitignore`. Use `.env.example` as a template; real credentials stay local or in your CI/deployment secrets.
- **Never commit `.cookies.json` or `credentials.json`** — these contain auth tokens and are also gitignored.
- See [SECURITY.md](SECURITY.md) for more detail.

## Quick start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

| Variable                    | Required | Description                                        |
| --------------------------- | -------- | -------------------------------------------------- |
| `SUPABASE_URL`              | Yes      | Your Supabase project URL                          |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes      | Service-role key (bypasses RLS)                    |
| `BOT_USER_AGENT`            | No       | Custom User-Agent string (default: `MilesC-GymBot/1.0`) |
| `RATE_LIMIT_MS`             | No       | Min delay between requests to same domain (default: `2000`) |
| `OPENAI_API_KEY`            | No       | Required for the LLM navigation planner            |
| `LLM_BUDGET_CENTS`          | No       | Max cumulative LLM spend in cents (default: `50`)  |
| `GYM_USERNAME`              | No       | Login credentials for auth-gated gym sites         |
| `GYM_PASSWORD`              | No       | Login credentials for auth-gated gym sites         |
| `GYM_TOTP_SECRET`           | No       | Base32 TOTP secret for 2FA                         |
| `COOKIE_TTL_HOURS`          | No       | Cookie freshness threshold (default: `24`)         |
| `MAX_CRAWL_DEPTH`           | No       | Max link-following depth (default: `5`)            |

### 3. Run the database migration

Open the Supabase SQL Editor (or use the CLI) and execute:

```bash
# If using the Supabase CLI:
supabase db push < sql/001_create_tables.sql
```

Or paste the contents of `sql/001_create_tables.sql` into the SQL Editor in your Supabase dashboard.

### 4. Scrape a gym

```bash
# Development (ts-node, no build step)
npx ts-node src/gymScanner.ts https://example-gym.com/schedule America/New_York

# Production (build first)
npm run build
node dist/gymScanner.js https://example-gym.com/schedule America/New_York
```

The second argument is the gym's IANA timezone. It defaults to `UTC` if omitted.

## Project structure

```
src/
├── agents/                        # Intelligence layer
│   ├── navigationPlanner.ts       # LLM-powered element discovery (gpt-4o-mini)
│   ├── sessionManager.ts          # Login state monitor + 2FA + cookie persistence
│   ├── dayWorkerPool.ts           # Parallel API-level schedule extraction
│   └── index.ts                   # Barrel exports
├── core/
│   ├── browserManager.ts          # Singleton Puppeteer + fingerprint/session setup
│   ├── dateNormalizer.ts          # "Monday 6PM" + timezone → UTC ISO string
│   ├── hardwareProfiles.ts        # GPU/screen/platform profiles for noise injection
│   ├── logger.ts                  # Natural-language progress logs
│   └── types.ts                   # Shared TypeScript interfaces + AgentConfig
├── middleware/
│   ├── compliance.ts              # User-Agent, robots.txt, 402 handler, rate limiter
│   ├── extractionValidator.ts     # Proof-by-validation (5-check trust loop)
│   ├── fingerprintNoise.ts        # Canvas/WebGL/AudioContext noise injection
│   ├── humanBehavior.ts           # ghost-cursor + custom scroll/type/idle
│   ├── lightFetcher.ts            # got-scraping HTTP with JA4 defeat
│   ├── stealthFetcher.ts          # Light→browser fallback orchestrator
│   ├── trapDetector.ts            # AI labyrinth / loop / entropy detection
│   └── index.ts                   # Barrel exports
├── scrapers/
│   ├── baseScraper.ts             # Abstract base + heuristic helpers
│   ├── genericScraper.ts          # Fallback parser for arbitrary HTML
│   └── index.ts                   # Scraper factory (MindBody / Glofox / Generic)
├── services/
│   └── supabaseService.ts         # Batch upserts to Supabase
└── gymScanner.ts                  # Main 9-stage orchestrator + CLI entry point

sql/
└── 001_create_tables.sql          # Foundational DB schema
```

## How the pipeline works

```
URL
 │
 ▼
1. COMPLIANCE ─── robots.txt check, rate limiting, User-Agent
 │
 ▼
2. TRAP GUARD ─── URL pattern analysis, depth tracking
 │
 ▼
3. FETCH ─── Light HTTP (got-scraping, JA4 defeat) → fallback to Puppeteer
 │            with fingerprint noise + human idle behaviour
 ▼
4. PLAN ─── LLM navigation planner identifies interactive elements
 │           (schedule, "Next Day" button, auth walls)
 ▼
5. EXTRACT ─── Scraper factory picks best parser (MindBody / Glofox / Generic)
 │
 ▼
6. VALIDATE ─── Cross-reference against secondary page signals
 │               Retry with modified strategy on failure
 ▼
7. NORMALISE ─── "Monday 6:00 PM" + "America/New_York" → UTC ISO
 │
 ▼
8. PERSIST ─── Supabase batch upserts (org → locations → classes)
 │
 ▼
9. PARALLEL ─── Day-worker pool fetches remaining days concurrently
 │
 ▼
Done — logs summary, returns ScanResult
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `puppeteer` + `puppeteer-extra` + stealth plugin | Browser automation with anti-detection |
| `cheerio` | Server-side HTML parsing |
| `got-scraping` | TLS-impersonating HTTP client (JA4 defeat) |
| `ghost-cursor` | Human-like mouse movements (Bezier, Fitts's Law, overshoot) |
| `bottleneck` | Per-domain rate limiting with concurrency and burst control |
| `robots-parser` | robots.txt compliance checking |
| `openai` | LLM navigation planner (gpt-4o-mini) |
| `otplib` | TOTP 2FA code generation |
| `luxon` | Timezone-aware date/time parsing |
| `@supabase/supabase-js` | Supabase client for batch upserts |

## Adding a new scraper

1. Create `src/scrapers/mindBodyScraper.ts` extending `BaseScraper`.
2. Implement the `extract(html, url)` method using platform-specific selectors.
3. Open `src/scrapers/index.ts` and add a detection rule before the generic fallback:

```typescript
if (html.includes('healcode') || html.includes('mindbodyonline.com')) {
  return new MindBodyScraper();
}
```

The generic scraper remains the catch-all fallback.

## Database schema

Three tables with FK relationships:

- **organizations** — gym brand, keyed by `website_url` (unique).
- **locations** — physical studios, keyed by `(organization_id, name)`.
- **classes** — scheduled classes, keyed by `(location_id, start_time, name)` — the "anti-duplicate shield".

See `sql/001_create_tables.sql` for the full DDL.

## License

MIT
