# Gym Scraper

A production-grade web scraping engine that extracts gym schedules, locations, and class data from gym websites and upserts the results into a Supabase (PostgreSQL) database.

## Features

- **Anti-bot evasion** — Puppeteer with the stealth plugin bypasses Cloudflare, Datadome, and similar protections.
- **Singleton browser** — One Chromium instance, many lightweight incognito tabs. No zombie browsers, no RAM leaks.
- **Timezone-aware date normalisation** — "Monday 6:00 PM" is converted to an absolute UTC timestamp using the gym's IANA timezone.
- **Idempotent batch upserts** — Running the scraper twice on the same URL updates existing rows instead of creating duplicates. All classes are sent in a single HTTP request per batch.
- **Pluggable scraper factory** — Automatically detects MindBody, Glofox, or generic HTML and routes to the best parser. Adding a new platform is a two-file change.

## Before you push to GitHub

- **Never commit `.env`** — it is in `.gitignore`. Use `.env.example` as a template; real credentials stay local or in your CI/deployment secrets.
- See [SECURITY.md](SECURITY.md) for more detail.

## Quick start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in your Supabase credentials:

```bash
cp .env.example .env
```

| Variable                    | Description                              |
| --------------------------- | ---------------------------------------- |
| `SUPABASE_URL`              | Your Supabase project URL                |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key (bypasses RLS)          |

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
├── core/
│   ├── browserManager.ts   # Singleton Puppeteer — prevents RAM leaks
│   ├── dateNormalizer.ts    # "Monday 6PM" + timezone → UTC ISO string
│   ├── logger.ts            # Natural-language progress logs
│   └── types.ts             # Shared TypeScript interfaces
├── middleware/
│   ├── index.ts             # Barrel export
│   └── stealthFetcher.ts    # Browser fetch with stealth plugin
├── scrapers/
│   ├── baseScraper.ts       # Abstract base + heuristic helpers
│   ├── genericScraper.ts    # Fallback parser for arbitrary HTML
│   └── index.ts             # Scraper factory (MindBody / Glofox / Generic)
├── services/
│   └── supabaseService.ts   # Batch upserts to Supabase
└── gymScanner.ts            # Main orchestrator + CLI entry point

sql/
└── 001_create_tables.sql    # Foundational DB schema
```

## How the pipeline works

```
URL
 │
 ▼
StealthFetcher (BrowserManager.withPage)
 │  → launches Chromium once, reuses across URLs
 │  → stealth plugin masks automation signals
 ▼
ScraperFactory
 │  → inspects DOM for MindBody / Glofox / generic signals
 │  → returns the most specialised parser
 ▼
Scraper.extract()
 │  → heuristics find addresses, schedule tables, class names
 │  → returns raw ScrapeResult (times still as local strings)
 ▼
DateNormalizer
 │  → "Monday 6:00 PM" + "America/New_York" → "2026-02-16T23:00:00.000Z"
 ▼
SupabaseService
 │  → upsertOrganization (1 request)
 │  → upsertLocations    (1 request)
 │  → upsertClasses      (1 request — entire array in one call)
 ▼
Done — logs summary, returns ScanResult
```

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
