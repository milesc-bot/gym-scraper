/**
 * middleware/index.ts — Barrel export for the middleware layer.
 *
 * WHY a barrel file?
 * ──────────────────
 * The rest of the codebase imports from `middleware` (one path) rather than
 * reaching into `middleware/stealthFetcher` directly.  When we later add
 * proxy rotation, CAPTCHA solvers, or rate-limiting helpers they get exported
 * here and every consumer picks them up automatically — zero import-path churn.
 */

export { fetchWithStealth } from './stealthFetcher';
