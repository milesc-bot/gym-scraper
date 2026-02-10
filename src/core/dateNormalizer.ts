/**
 * dateNormalizer.ts — Convert scraped relative/local times into absolute UTC ISO strings.
 *
 * THE PROBLEM THIS SOLVES
 * ───────────────────────
 * Gym websites almost never give you "2026-02-10T18:00:00-05:00".  Instead you
 * see text like:
 *
 *   "Monday  6:00 PM"   — no date, no timezone
 *   "Tomorrow 9:00 AM"  — relative to *when* you scrape
 *   "Today 5:30 PM"     — same issue
 *
 * If we store these strings verbatim we get two failures:
 *   1. **Duplicate classes** — scraping on Sunday produces a different "Monday"
 *      date than scraping on Tuesday, so the upsert thinks they are two classes.
 *   2. **Wrong timezone** — "6:00 PM" in New York is not the same instant as
 *      "6:00 PM" in Chicago.  Without the location's IANA timezone the stored
 *      TIMESTAMPTZ is wrong.
 *
 * DateNormalizer fixes both by:
 *   a) Resolving relative day names to the *next* calendar date (from a reference
 *      date, defaulting to "today in the gym's timezone").
 *   b) Interpreting the time in the gym's local timezone and converting to UTC.
 *
 * WHY Luxon?
 * ──────────
 * Luxon's `DateTime.fromFormat()` + `.setZone()` pipeline handles IANA zones,
 * DST transitions, and format parsing in one library.  date-fns-tz is a solid
 * alternative, but Luxon's immutable API makes chaining safer and harder to
 * misuse (no accidental mutation of an intermediate DateTime).
 */

import { DateTime, Info } from 'luxon';

// ── Day-name lookup ────────────────────────────────────────

/**
 * Map lowercase English day names / abbreviations to Luxon's 1-based weekday
 * numbers (1 = Monday … 7 = Sunday, per ISO 8601).
 *
 * WHY build this map at module load?
 * Doing the string work once avoids repeated toLowerCase + indexOf calls
 * inside the hot path of `resolveNextDay`.
 */
const DAY_MAP: Record<string, number> = {};
(() => {
  // Full names: "monday" → 1, "tuesday" → 2, …
  const fullNames = Info.weekdays('long', { locale: 'en' });
  fullNames.forEach((name, idx) => {
    DAY_MAP[name.toLowerCase()] = idx + 1;
  });

  // 3-letter abbreviations: "mon" → 1, "tue" → 2, …
  const shortNames = Info.weekdays('short', { locale: 'en' });
  shortNames.forEach((name, idx) => {
    DAY_MAP[name.toLowerCase()] = idx + 1;
  });
})();

// ── Public API ─────────────────────────────────────────────

/**
 * Parse a scraped date/time string and return an absolute UTC ISO string.
 *
 * @param raw       - Text from the page, e.g. "Monday 6:00 PM", "Tomorrow 9AM",
 *                    "10:30 AM" (day assumed to be today).
 * @param timezone  - IANA zone of the gym location (e.g. "America/New_York").
 * @param refDate   - Reference "now" for resolving relative days.
 *                    Defaults to the current instant in `timezone`.
 *
 * @returns UTC ISO-8601 string, e.g. "2026-02-16T23:00:00.000Z"
 * @throws  If the string cannot be parsed into a valid DateTime.
 *
 * WHY return a string rather than a Luxon DateTime?
 * The Supabase JS client serialises dates as ISO strings anyway.  Returning
 * a string keeps the contract simple and avoids leaking Luxon types into the
 * rest of the codebase (consumers only depend on plain strings + `core/types`).
 */
export function normalizeDateTime(
  raw: string,
  timezone: string,
  refDate?: DateTime,
): string {
  const trimmed = raw.trim();

  // Default "now" in the gym's timezone so relative day math is correct.
  const now = refDate ?? DateTime.now().setZone(timezone);

  // ── Step 1: Split into day-part and time-part ──────────

  const { dayPart, timePart } = splitDayAndTime(trimmed);

  // ── Step 2: Resolve the calendar date ──────────────────

  const targetDate = resolveDate(dayPart, now, timezone);

  // ── Step 3: Parse the time component ───────────────────

  const { hour, minute } = parseTime(timePart);

  // ── Step 4: Combine date + time in the gym's zone, convert to UTC ──

  const local = targetDate.set({ hour, minute, second: 0, millisecond: 0 });
  const utc = local.toUTC();

  if (!utc.isValid) {
    throw new Error(
      `DateNormalizer: could not produce a valid UTC datetime from "${raw}" ` +
        `in timezone "${timezone}".  Luxon reason: ${utc.invalidReason}`,
    );
  }

  return utc.toISO()!;
}

// ── Internals ──────────────────────────────────────────────

/**
 * Separate a raw string into an optional day indicator and a time string.
 *
 * Examples:
 *   "Monday 6:00 PM"  → { dayPart: "monday", timePart: "6:00 PM" }
 *   "Tomorrow 9AM"    → { dayPart: "tomorrow", timePart: "9AM" }
 *   "10:30 AM"        → { dayPart: null, timePart: "10:30 AM" }
 *
 * WHY regex over a date-parsing library?
 * Gym sites use wildly inconsistent formats.  A focused regex for "word then
 * digits-colon-digits" is more reliable than asking a general-purpose parser
 * to guess whether "Monday" is a month abbreviation in some locale.
 */
function splitDayAndTime(text: string): {
  dayPart: string | null;
  timePart: string;
} {
  // Match an optional leading word (day name / "today" / "tomorrow") followed
  // by time-like characters (digits, colon, am/pm).
  const match = text.match(
    /^([a-zA-Z]+)\s+(\d{1,2}(?::\d{2})?\s*(?:AM|PM|am|pm)?)$/i,
  );

  if (match) {
    return { dayPart: match[1].toLowerCase(), timePart: match[2] };
  }

  // No leading word — the entire string is the time portion.
  return { dayPart: null, timePart: text };
}

/**
 * Turn a day indicator into a concrete Luxon DateTime (date-only, in the gym's zone).
 *
 * Supports:
 *   • `null`       → today
 *   • "today"      → today
 *   • "tomorrow"   → today + 1
 *   • Day names    → *next* occurrence (including today if it matches)
 *
 * WHY "next occurrence including today"?
 * If a gym lists "Monday" classes and we scrape on a Monday morning, we want
 * *today's* Monday — not next week's.  If we scrape on Tuesday the next Monday
 * is 6 days away, which is correct.
 */
function resolveDate(
  dayPart: string | null,
  now: DateTime,
  timezone: string,
): DateTime {
  if (!dayPart || dayPart === 'today') {
    return now;
  }

  if (dayPart === 'tomorrow') {
    return now.plus({ days: 1 });
  }

  const targetWeekday = DAY_MAP[dayPart];
  if (targetWeekday === undefined) {
    // WHY fall back to today instead of throwing?
    // Some gym sites use labels we haven't mapped (e.g. "This Evening").
    // Returning today is a safer guess that still produces a valid timestamp;
    // the caller can log a warning.
    return now;
  }

  return resolveNextDay(now, targetWeekday);
}

/**
 * Advance from `now` to the next date whose weekday matches `targetWeekday`.
 * If today is already that weekday, return today.
 *
 * WHY modular arithmetic instead of a loop?
 * A loop (`while (d.weekday !== target) d = d.plus({days:1})`) works but is
 * O(7) in the worst case and harder to reason about.  The formula
 * `(target - current + 7) % 7` always gives the correct offset in O(1).
 */
function resolveNextDay(now: DateTime, targetWeekday: number): DateTime {
  const currentWeekday = now.weekday; // 1 (Mon) – 7 (Sun)
  const daysAhead = (targetWeekday - currentWeekday + 7) % 7;
  return now.plus({ days: daysAhead });
}

/**
 * Parse a time string like "6:00 PM", "9AM", "14:30" into 24-hour { hour, minute }.
 *
 * WHY manual parsing?
 * Luxon's `fromFormat` is great, but gym sites use at least four different
 * formats ("6PM", "6:00PM", "6:00 PM", "18:00").  Handling them all with a
 * single regex + branch is simpler and more predictable than guessing format
 * strings.
 */
function parseTime(time: string): { hour: number; minute: number } {
  const cleaned = time.trim().toUpperCase();

  // Try 12-hour: "6:00 PM", "6:00PM", "6PM", "6 PM"
  const match12 = cleaned.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/);
  if (match12) {
    let hour = parseInt(match12[1], 10);
    const minute = match12[2] ? parseInt(match12[2], 10) : 0;
    const meridiem = match12[3];

    // Standard 12→24 conversion
    if (meridiem === 'PM' && hour !== 12) hour += 12;
    if (meridiem === 'AM' && hour === 12) hour = 0;

    return { hour, minute };
  }

  // Try 24-hour: "14:30", "08:00"
  const match24 = cleaned.match(/^(\d{1,2}):(\d{2})$/);
  if (match24) {
    return {
      hour: parseInt(match24[1], 10),
      minute: parseInt(match24[2], 10),
    };
  }

  throw new Error(
    `DateNormalizer: unable to parse time "${time}".  ` +
      `Expected formats: "6:00 PM", "6PM", "14:30".`,
  );
}
