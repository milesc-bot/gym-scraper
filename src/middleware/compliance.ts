/**
 * compliance.ts — Ethical and technical compliance layer.
 *
 * This module implements four "good citizen" behaviours:
 *
 * 1. **Custom User-Agent** — Transparent identification so site operators
 *    can whitelist or contact us.
 * 2. **HTTP 402 handling** — Graceful response to "Pay-to-Crawl" firewalls
 *    (Cloudflare, TollBit) instead of endless retries.
 * 3. **robots.txt checking** — Respect crawl rules before fetching.
 * 4. **Rate limiting** — Per-domain throttling via Bottleneck to avoid
 *    hammering a single host.
 *
 * WHY compliance when we are also adding stealth?
 * ───────────────────────────────────────────────
 * The 2026 web splits into two postures:
 *   • Sites that BLOCK bots aggressively → stealth is necessary.
 *   • Sites that WHITELIST well-behaved bots → compliance gets us access.
 * Running both layers lets us adapt to either posture per-site.
 */

import Bottleneck from 'bottleneck';
import robotsParser from 'robots-parser';
import { Logger } from '../core/logger';
import type { AgentConfig } from '../core/types';
import { lightFetch } from './lightFetcher';

const logger = new Logger('Compliance');

// ─── User-Agent ─────────────────────────────────────────────

/**
 * Return the bot's User-Agent string, configurable via env var.
 *
 * WHY a transparent UA?
 * The report highlights that operating as a "reputable" bot is often
 * preferable to being fed poisoned data via Nightshade-style attacks.
 * A clear UA lets site operators contact us or whitelist us.
 */
export function getBotUserAgent(config: AgentConfig): string {
  return config.botUserAgent;
}

// ─── HTTP 402 handling ──────────────────────────────────────

/**
 * Check whether an HTTP status code indicates a "Pay-to-Crawl" firewall.
 *
 * WHY handle 402 specifically?
 * HTTP 402 "Payment Required" is used by services like Cloudflare and
 * TollBit to signal that crawling is behind a paywall.  Retrying will
 * never succeed — the correct response is to log a warning and skip.
 */
export function isPaywallResponse(statusCode: number): boolean {
  return statusCode === 402;
}

/**
 * Check whether a status code indicates an auth wall (401 / 403).
 */
export function isAuthWallResponse(statusCode: number): boolean {
  return statusCode === 401 || statusCode === 403;
}

// ─── robots.txt checker ─────────────────────────────────────

// Cache robots.txt per domain for the session — same domain's robots.txt
// rarely changes within a single run.
const robotsCache = new Map<string, ReturnType<typeof robotsParser>>();

/**
 * Check if our bot is allowed to crawl a given URL per robots.txt.
 *
 * @param url - The target URL to check.
 * @param config - Agent config (for the User-Agent string).
 * @returns `true` if allowed (or if robots.txt is unavailable), `false` if disallowed.
 *
 * WHY default to "allowed" on fetch failure?
 * A missing or unreachable robots.txt is treated as "no restrictions"
 * per the robots exclusion standard (RFC 9309).
 */
export async function isAllowedByRobots(
  url: string,
  config: AgentConfig,
): Promise<boolean> {
  let hostname: string;
  let origin: string;
  try {
    const parsed = new URL(url);
    hostname = parsed.hostname;
    origin = parsed.origin;
  } catch {
    // Unparseable URL — let it through and let the fetch layer handle it.
    return true;
  }

  // Check cache first.
  if (robotsCache.has(hostname)) {
    const robots = robotsCache.get(hostname)!;
    const allowed = robots.isAllowed(url, config.botUserAgent) ?? true;
    if (!allowed) {
      logger.warn(
        `robots.txt disallows ${url} for UA "${config.botUserAgent}"`,
      );
    }
    return allowed;
  }

  // Fetch and parse robots.txt.
  try {
    const robotsUrl = `${origin}/robots.txt`;
    const result = await lightFetch(robotsUrl, { timeout: 5_000 });

    if (result.statusCode === 200) {
      const robots = robotsParser(robotsUrl, result.body);
      robotsCache.set(hostname, robots);
      const allowed = robots.isAllowed(url, config.botUserAgent) ?? true;
      if (!allowed) {
        logger.warn(
          `robots.txt disallows ${url} for UA "${config.botUserAgent}"`,
        );
      }
      return allowed;
    }
  } catch (err) {
    logger.warn(
      `Could not fetch robots.txt for ${hostname} — assuming allowed`,
    );
  }

  return true; // Default: allowed.
}

/**
 * Clear the robots.txt cache (useful between batch runs).
 */
export function clearRobotsCache(): void {
  robotsCache.clear();
}

// ─── Rate limiter (Bottleneck) ──────────────────────────────

// Per-domain Bottleneck instances.
const limiters = new Map<string, Bottleneck>();

/**
 * Create or retrieve a per-domain rate limiter.
 *
 * WHY Bottleneck instead of a simple Map<host, timestamp>?
 * ────────────────────────────────────────────────────────
 * 1. **Concurrency safety:**  If multiple tabs / promises target the same
 *    domain, Bottleneck serialises them without race conditions.
 * 2. **Burst support:**  The `reservoir` option allows N fast requests
 *    before throttling kicks in — useful for API pattern discovery.
 * 3. **Scalability:**  Bottleneck.Cluster + Redis lets this same code
 *    scale to multiple machines without changes to callers.
 */
export function getRateLimiter(
  hostname: string,
  config: AgentConfig,
): Bottleneck {
  if (limiters.has(hostname)) {
    return limiters.get(hostname)!;
  }

  const limiter = new Bottleneck({
    // Only 1 request at a time to the same host (page-load limiter).
    maxConcurrent: 1,
    // Minimum time between requests — configurable via RATE_LIMIT_MS.
    minTime: config.rateLimitMs,
  });

  limiters.set(hostname, limiter);
  return limiter;
}

/**
 * Create a more permissive rate limiter for API-level requests
 * (used by the day-worker pool).
 *
 * WHY a separate config?
 * API calls are lightweight (no page render) and gym sites can handle
 * higher concurrency.  3 concurrent requests with 500 ms spacing is
 * aggressive but within reason for fetching 7 days of schedule data.
 */
export function getApiRateLimiter(hostname: string): Bottleneck {
  const key = `api:${hostname}`;
  if (limiters.has(key)) {
    return limiters.get(key)!;
  }

  const limiter = new Bottleneck({
    maxConcurrent: 3,
    minTime: 500,
    // Allow 5 fast requests before throttling — the initial "burst"
    // for discovering all 7 days.
    reservoir: 5,
    reservoirRefreshAmount: 5,
    reservoirRefreshInterval: 10_000, // Refill every 10 s.
  });

  limiters.set(key, limiter);
  return limiter;
}

/**
 * Clear all rate limiters (useful between batch runs).
 */
export function clearRateLimiters(): void {
  for (const limiter of limiters.values()) {
    limiter.disconnect();
  }
  limiters.clear();
}
