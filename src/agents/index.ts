/**
 * agents/index.ts — Barrel export for the intelligence layer.
 *
 * WHY a separate `agents/` directory?
 * ───────────────────────────────────
 * The `middleware/` directory contains stateless request-level concerns
 * (fetch, noise injection, compliance checks).  The `agents/` directory
 * contains *stateful, intelligent* modules that reason about the scraping
 * session as a whole:
 *   • Navigation Planner — LLM-powered element discovery
 *   • Session Manager    — Login state + re-authentication
 *   • Day Worker Pool    — Parallel API-level schedule extraction
 */

export {
  planNavigation,
  clearPlannerCache,
  getLlmSpendCents,
} from './navigationPlanner';

export {
  getSessionState,
  waitForSession,
  attachLoginMonitor,
  checkForLoginWall,
  loadSavedCookies,
  saveCookies,
} from './sessionManager';

export {
  analyseInterceptedRequests,
  fetchWeekParallel,
  setupRequestCapture,
} from './dayWorkerPool';
export type { DayWorkerResult } from './dayWorkerPool';
