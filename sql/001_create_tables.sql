-- ╔══════════════════════════════════════════════════════════════════════╗
-- ║  001_create_tables.sql — Foundational schema for the gym scraper   ║
-- ╚══════════════════════════════════════════════════════════════════════╝
--
-- RUN THIS MIGRATION against your Supabase project *before* starting the
-- scraper.  You can paste it into the Supabase SQL Editor or apply it via
-- the Supabase CLI (`supabase db push`).
--
-- KEY DESIGN DECISIONS
-- ────────────────────
-- • UUIDs as primary keys — avoids sequential-ID enumeration and simplifies
--   future multi-region replication.
-- • TIMESTAMPTZ for class times — stores absolute UTC instants.  The
--   application layer (DateNormalizer) converts local gym times before insert.
-- • Composite unique constraint on `classes` — the "anti-duplicate shield".
--   Running the scraper twice for the same gym produces *upserts*, not dupes.
-- • `timezone` on `locations` — drives DateNormalizer; without it we cannot
--   correctly interpret "6:00 PM" from a gym in Denver vs one in Boston.

-- ─── Organizations ─────────────────────────────────────────
-- A gym brand / company.  `website_url` is unique so re-scraping the same
-- site upserts the existing row rather than creating a second organization.

CREATE TABLE IF NOT EXISTS organizations (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name        TEXT NOT NULL,
  website_url TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- ─── Locations ─────────────────────────────────────────────
-- A physical studio / branch.  The combination of (organization_id, name) is
-- unique so a gym with two branches named differently won't collide, but
-- re-scraping the same branch won't create a duplicate.

CREATE TABLE IF NOT EXISTS locations (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  address         TEXT,
  timezone        TEXT NOT NULL DEFAULT 'UTC',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),

  CONSTRAINT locations_org_name_key UNIQUE (organization_id, name)
);

-- ─── Classes ───────────────────────────────────────────────
-- A single scheduled class.  The composite key (location_id, start_time, name)
-- is the "anti-duplicate shield":
--   • Same location + same start time + same class name → same row.
--   • Re-scraping updates mutable fields (instructor, spots_total) in place
--     via the Supabase `upsert` call with `ignoreDuplicates: false`.

CREATE TABLE IF NOT EXISTS classes (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  start_time  TIMESTAMPTZ NOT NULL,
  end_time    TIMESTAMPTZ,
  instructor  TEXT,
  spots_total INT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),

  CONSTRAINT classes_dedupe_key UNIQUE (location_id, start_time, name)
);

-- ─── Indexes ───────────────────────────────────────────────
-- WHY explicit indexes on foreign keys?
-- PostgreSQL does *not* auto-create indexes on FK columns.  Without these,
-- queries like "all classes for location X" or "all locations for org Y"
-- would require full table scans once the tables grow.

CREATE INDEX IF NOT EXISTS idx_locations_org ON locations (organization_id);
CREATE INDEX IF NOT EXISTS idx_classes_location ON classes (location_id);
