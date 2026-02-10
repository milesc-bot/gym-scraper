/**
 * middleware/index.ts — Barrel export for the middleware layer.
 *
 * WHY a barrel file?
 * ──────────────────
 * The rest of the codebase imports from `middleware` (one path) rather than
 * reaching into individual middleware files directly.  When we add new
 * middleware modules they get exported here and every consumer picks them
 * up automatically — zero import-path churn.
 */

// ── Fetch layer ─────────────────────────────────────────────
export { fetchWithStealth, fetchHtml } from './stealthFetcher';
export { lightFetch } from './lightFetcher';

// ── Fingerprint noise ───────────────────────────────────────
export { injectFingerprintNoise } from './fingerprintNoise';

// ── Human behaviour ─────────────────────────────────────────
export {
  createHumanCursor,
  humanClick,
  humanMove,
  humanScroll,
  humanType,
  randomIdle,
} from './humanBehavior';

// ── Trap detection ──────────────────────────────────────────
export { TrapDetector } from './trapDetector';

// ── Compliance ──────────────────────────────────────────────
export {
  getBotUserAgent,
  isPaywallResponse,
  isAuthWallResponse,
  isAllowedByRobots,
  getRateLimiter,
  getApiRateLimiter,
  clearRobotsCache,
  clearRateLimiters,
} from './compliance';

// ── Extraction validator ────────────────────────────────────
export { validateExtraction } from './extractionValidator';
