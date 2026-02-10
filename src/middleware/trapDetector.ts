/**
 * trapDetector.ts — Detect and avoid AI labyrinth traps and deceptive pages.
 *
 * WHY do we need trap detection?
 * ──────────────────────────────
 * Modern anti-scraping defences deploy "AI Labyrinths": recursive networks
 * of AI-generated fake pages designed to:
 *   1. Exhaust compute resources (infinite links to follow)
 *   2. Poison scraped data (realistic-looking but nonsensical content)
 *   3. Fingerprint bots by tracking their navigation patterns
 *
 * This module provides four independent detection heuristics that together
 * catch the most common trap patterns.  Each heuristic can be disabled or
 * tuned via configuration.
 *
 * WHEN does this matter?
 * ─────────────────────
 * Currently the scraper processes a single URL per run.  Trap detection
 * becomes critical when batch-crawling or link-following is added.  The
 * infrastructure is built now so it's ready when that day comes.
 */

import { createHash } from 'crypto';
import { Logger } from '../core/logger';

const logger = new Logger('TrapDetector');

// ─── Types ─────────────────────────────────────────────────

export interface TrapCheckResult {
  /** Whether the URL / content appears safe to process. */
  safe: boolean;
  /** Human-readable reason if flagged. */
  reason?: string;
}

// ─── TrapDetector class ────────────────────────────────────

export class TrapDetector {
  /** Per-domain set of visited URLs — prevents revisiting the same page. */
  private visitedUrls = new Map<string, Set<string>>();
  /** Per-domain content hashes — detects duplicate/recycled content. */
  private contentHashes = new Map<string, Set<string>>();
  /** Per-domain depth counter — how deep into a link chain we are. */
  private depthCounters = new Map<string, number>();
  /** Maximum allowed crawl depth before aborting. */
  private maxDepth: number;

  constructor(maxDepth: number = 5) {
    this.maxDepth = maxDepth;
  }

  // ── Pre-fetch checks (run BEFORE navigating to a URL) ───

  /**
   * Check whether a URL is safe to fetch based on structural signals.
   *
   * This runs BEFORE the fetch to avoid wasting a request on a known trap.
   */
  checkUrl(url: string): TrapCheckResult {
    const hostname = this.extractHostname(url);

    // 1. Depth check — are we too deep in a link chain?
    const currentDepth = this.depthCounters.get(hostname) ?? 0;
    if (currentDepth >= this.maxDepth) {
      logger.warn(
        `Depth limit (${this.maxDepth}) reached for ${hostname} — aborting path`,
      );
      return {
        safe: false,
        reason: `Crawl depth limit (${this.maxDepth}) exceeded for domain ${hostname}`,
      };
    }

    // 2. Already visited — don't re-fetch the same URL.
    const visited = this.visitedUrls.get(hostname) ?? new Set();
    if (visited.has(url)) {
      logger.warn(`URL already visited: ${url}`);
      return { safe: false, reason: `URL already visited: ${url}` };
    }

    // 3. URL pattern analysis — detect suspicious structures.
    const patternResult = this.analyseUrlPattern(url);
    if (!patternResult.safe) {
      return patternResult;
    }

    return { safe: true };
  }

  // ── Post-fetch checks (run AFTER extracting content) ─────

  /**
   * Check whether extracted content looks like real data or a trap.
   *
   * @param url - The URL that was fetched.
   * @param content - The extracted text or HTML body.
   * @param classCount - Number of schedule classes extracted (0 = suspicious).
   */
  checkContent(
    url: string,
    content: string,
    classCount: number,
  ): TrapCheckResult {
    const hostname = this.extractHostname(url);

    // 1. Content hash — detect duplicate / recycled pages.
    const hash = this.hashContent(content);
    const hashes = this.contentHashes.get(hostname) ?? new Set();
    if (hashes.has(hash)) {
      logger.warn(`Duplicate content detected for ${url} — likely a trap`);
      return {
        safe: false,
        reason: 'Page content is identical to a previously seen page (loop detected)',
      };
    }

    // 2. Information density — high word count with no schedule data
    //    suggests an AI-generated filler page.
    const densityResult = this.checkInformationDensity(content, classCount);
    if (!densityResult.safe) {
      return densityResult;
    }

    // All checks passed — mark URL as visited and store the hash.
    hashes.add(hash);
    this.contentHashes.set(hostname, hashes);

    const visited = this.visitedUrls.get(hostname) ?? new Set();
    visited.add(url);
    this.visitedUrls.set(hostname, visited);

    // Increment depth.
    this.depthCounters.set(hostname, (this.depthCounters.get(hostname) ?? 0) + 1);

    return { safe: true };
  }

  /**
   * Reset state for a specific domain (useful between batch runs).
   */
  resetDomain(hostname: string): void {
    this.visitedUrls.delete(hostname);
    this.contentHashes.delete(hostname);
    this.depthCounters.delete(hostname);
  }

  /**
   * Reset all state (useful at the start of a new batch run).
   */
  resetAll(): void {
    this.visitedUrls.clear();
    this.contentHashes.clear();
    this.depthCounters.clear();
  }

  // ── Private heuristics ───────────────────────────────────

  /**
   * Detect suspicious URL structures:
   *   • Recursive path segments (/page/page/page/...)
   *   • Excessive query parameters (>8)
   *   • Random-looking path segments (high entropy)
   */
  private analyseUrlPattern(url: string): TrapCheckResult {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { safe: false, reason: `Invalid URL: ${url}` };
    }

    const pathSegments = parsed.pathname.split('/').filter(Boolean);

    // Recursive path segments — e.g. /page/page/page/page
    const segmentCounts = new Map<string, number>();
    for (const seg of pathSegments) {
      segmentCounts.set(seg, (segmentCounts.get(seg) ?? 0) + 1);
    }
    for (const [segment, count] of segmentCounts) {
      if (count >= 3) {
        logger.warn(
          `Recursive path detected: "${segment}" appears ${count}× in ${url}`,
        );
        return {
          safe: false,
          reason: `Recursive path segment "${segment}" repeated ${count} times`,
        };
      }
    }

    // Excessive query parameters — real gym pages rarely have >5.
    const paramCount = [...parsed.searchParams].length;
    if (paramCount > 8) {
      logger.warn(
        `Excessive query params (${paramCount}) in ${url} — possible trap`,
      );
      return {
        safe: false,
        reason: `URL has ${paramCount} query parameters (threshold: 8)`,
      };
    }

    // Random-looking path segments (high character entropy).
    for (const seg of pathSegments) {
      if (seg.length > 20 && this.entropy(seg) > 4.0) {
        logger.warn(`High-entropy path segment "${seg}" in ${url}`);
        return {
          safe: false,
          reason: `Path segment "${seg.slice(0, 30)}…" has unusually high entropy (likely random)`,
        };
      }
    }

    return { safe: true };
  }

  /**
   * Check information density: ratio of schedule-like tokens to total words.
   *
   * WHY this heuristic?
   * AI labyrinth pages are designed to look like real content from a distance
   * (high word count, proper grammar) but contain no actual schedule data
   * (no class names, times, instructor names).  A page with 2000 words
   * but zero schedule-like tokens is almost certainly a trap.
   */
  private checkInformationDensity(
    content: string,
    classCount: number,
  ): TrapCheckResult {
    const words = content.split(/\s+/).filter((w) => w.length > 1);
    const wordCount = words.length;

    // Short pages (< 100 words) are unlikely to be labyrinth filler.
    if (wordCount < 100) {
      return { safe: true };
    }

    // Schedule-like tokens: time patterns, day names, common gym words.
    const schedulePattern =
      /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)|monday|tuesday|wednesday|thursday|friday|saturday|sunday|yoga|pilates|hiit|spin|cycle|crossfit|barre|boxing|instructor|coach|studio|class)\b/gi;
    const scheduleTokens = content.match(schedulePattern) ?? [];
    const density = scheduleTokens.length / wordCount;

    // If the page has >500 words but virtually no schedule tokens,
    // and no classes were extracted, flag it as suspicious.
    if (wordCount > 500 && density < 0.005 && classCount === 0) {
      logger.warn(
        `Low information density: ${scheduleTokens.length} schedule tokens ` +
          `in ${wordCount} words (density: ${density.toFixed(4)})`,
      );
      return {
        safe: false,
        reason:
          `High word count (${wordCount}) with near-zero schedule tokens ` +
          `(${scheduleTokens.length}) — likely AI-generated filler content`,
      };
    }

    return { safe: true };
  }

  /** SHA-256 hash of content, truncated to 16 hex chars for memory efficiency. */
  private hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  /** Shannon entropy of a string — measures randomness (0 = uniform, >4 = high). */
  private entropy(str: string): number {
    const freq = new Map<string, number>();
    for (const c of str) {
      freq.set(c, (freq.get(c) ?? 0) + 1);
    }
    let ent = 0;
    for (const count of freq.values()) {
      const p = count / str.length;
      ent -= p * Math.log2(p);
    }
    return ent;
  }

  private extractHostname(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }
}
