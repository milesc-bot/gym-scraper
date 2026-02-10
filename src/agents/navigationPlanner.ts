/**
 * navigationPlanner.ts — LLM-powered element discovery for self-healing navigation.
 *
 * THE PROBLEM WITH HARDCODED SELECTORS
 * ─────────────────────────────────────
 * The current scraper uses regex and CSS class heuristics (e.g., checking
 * for "healcode", "glofox") to detect platforms.  When a gym site redesigns
 * or a platform ships a new widget version, these break silently — the
 * scraper extracts 0 classes and nobody notices until data goes stale.
 *
 * THE "SELF-HEALING" APPROACH
 * ───────────────────────────
 * Instead of hardcoded selectors, we:
 *   1. RECON  — Dump the page's accessibility tree (lightweight, ~5-20 KB).
 *   2. ANALYSE — Ask gpt-4o-mini to identify the schedule, nav buttons, etc.
 *   3. ACT    — Return selectors for the scraper to use.
 *
 * If a selector fails at click-time, the caller re-runs the planner (the LLM
 * may suggest an alternative).
 *
 * COST CONTROL
 * ────────────
 * gpt-4o-mini at ~$0.15/1M input tokens:  a 2K-token accessibility tree
 * costs ~$0.0003 per call.  We cache responses per-domain (layout doesn't
 * change mid-run) and enforce a cumulative budget via LLM_BUDGET_CENTS.
 */

import OpenAI from 'openai';
import type { Page } from 'puppeteer';
import type { PlannerResult, AgentConfig } from '../core/types';
import { Logger } from '../core/logger';

const logger = new Logger('NavigationPlanner');

// ─── LLM client (lazy-initialized) ─────────────────────────

let openaiClient: OpenAI | null = null;

function getOpenAI(config: AgentConfig): OpenAI {
  if (!openaiClient) {
    if (!config.openaiApiKey) {
      throw new Error(
        'OPENAI_API_KEY is not set.  The Navigation Planner requires an ' +
          'OpenAI API key to function.  Set it in your .env file.',
      );
    }
    openaiClient = new OpenAI({ apiKey: config.openaiApiKey });
  }
  return openaiClient;
}

// ─── Per-domain cache ───────────────────────────────────────

const plannerCache = new Map<string, PlannerResult>();

// ─── Budget tracking ────────────────────────────────────────

let cumulativeSpendCents = 0;

// gpt-4o-mini pricing (approximate, as of early 2026).
const INPUT_COST_PER_TOKEN = 0.15 / 1_000_000;   // $0.15 / 1M tokens
const OUTPUT_COST_PER_TOKEN = 0.60 / 1_000_000;   // $0.60 / 1M tokens

// ─── System prompt ──────────────────────────────────────────

const SYSTEM_PROMPT = `You are a web automation assistant.  Given the accessibility tree (or simplified HTML) of a gym schedule page, identify the following interactive elements.

Return ONLY valid JSON with this exact schema:
{
  "schedule_selector": "<CSS selector for the schedule container, or null>",
  "next_button_selector": "<CSS selector for the 'next day/week' button, or null>",
  "load_more_selector": "<CSS selector for any 'load more' or pagination control, or null>",
  "auth_wall_detected": <true if the page appears to be a login/auth wall, false otherwise>
}

Rules:
- Prefer selectors by role, aria-label, or data attributes (more stable than class names).
- If you cannot confidently identify an element, return null for that field.
- auth_wall_detected should be true if you see login forms, "Sign In" headings, or password fields.
- Do NOT wrap the JSON in markdown code fences.`;

// ─── Main API ───────────────────────────────────────────────

/**
 * Analyse a page and return CSS selectors for key interactive elements.
 *
 * @param page - The live Puppeteer Page to analyse.
 * @param config - Agent config (for API key and budget).
 * @param forceRefresh - If true, skip the cache and re-analyse.
 * @returns A PlannerResult with selectors and auth-wall detection.
 */
export async function planNavigation(
  page: Page,
  config: AgentConfig,
  forceRefresh: boolean = false,
): Promise<PlannerResult> {
  // Check cache.
  const url = page.url();
  const hostname = extractHostname(url);
  if (!forceRefresh && plannerCache.has(hostname)) {
    logger.info(`Using cached plan for ${hostname}`);
    return plannerCache.get(hostname)!;
  }

  // Budget guard.
  if (cumulativeSpendCents >= config.llmBudgetCents) {
    logger.warn(
      `LLM budget exhausted (${cumulativeSpendCents.toFixed(2)}¢ / ` +
        `${config.llmBudgetCents}¢).  Returning empty plan.`,
    );
    return emptyPlan();
  }

  // Phase 1: RECON — dump the accessibility tree.
  logger.info(`Phase 1 (Recon): Dumping accessibility tree for ${url}…`);
  const reconOutput = await dumpRecon(page);

  if (!reconOutput || reconOutput.length < 50) {
    logger.warn('Accessibility tree is empty or too short — returning empty plan');
    return emptyPlan();
  }

  // Phase 2: ANALYSIS — send to LLM.
  logger.info('Phase 2 (Analysis): Sending recon to gpt-4o-mini…');
  const result = await analysePage(reconOutput, config);

  // Cache the result.
  plannerCache.set(hostname, result);

  logger.info(
    `Phase 3 (Action): Plan ready — schedule: ${result.scheduleSelector ?? 'none'}, ` +
      `next: ${result.nextButtonSelector ?? 'none'}, ` +
      `auth wall: ${result.authWallDetected}`,
  );

  return result;
}

/**
 * Clear the planner cache (useful between batch runs or after a site update).
 */
export function clearPlannerCache(): void {
  plannerCache.clear();
}

/**
 * Get the cumulative LLM spend in cents.
 */
export function getLlmSpendCents(): number {
  return cumulativeSpendCents;
}

// ─── Phase 1: Recon ─────────────────────────────────────────

/**
 * Dump the page's accessibility tree, falling back to simplified HTML.
 *
 * WHY the accessibility tree?
 * It's a compact, semantic representation (~5-20 KB) that captures
 * roles, labels, and states — exactly what the LLM needs to identify
 * interactive elements.  Full HTML can be 100-500 KB and wastes tokens
 * on styles, scripts, and attributes the LLM doesn't need.
 */
async function dumpRecon(page: Page): Promise<string> {
  try {
    // Try accessibility tree first (Puppeteer built-in).
    const snapshot = await page.accessibility.snapshot();
    if (snapshot) {
      const serialised = JSON.stringify(snapshot, null, 2);
      // Truncate to ~8K tokens (~32K chars) to stay within budget.
      if (serialised.length > 32_000) {
        return serialised.slice(0, 32_000) + '\n[…truncated]';
      }
      return serialised;
    }
  } catch {
    logger.warn('Accessibility snapshot failed — falling back to simplified HTML');
  }

  // Fallback: simplified HTML (strip scripts, styles, keep semantic tags).
  try {
    const simplified = await page.evaluate(() => {
      const clone = document.documentElement.cloneNode(true) as HTMLElement;

      // Remove noise elements.
      const remove = clone.querySelectorAll(
        'script, style, noscript, svg, link[rel="stylesheet"], meta',
      );
      remove.forEach((el) => el.remove());

      // Remove inline styles and data attributes to reduce size.
      clone.querySelectorAll('*').forEach((el) => {
        el.removeAttribute('style');
        // Keep data-* attributes that might be useful for selectors.
      });

      return clone.outerHTML;
    });

    // Truncate.
    if (simplified.length > 32_000) {
      return simplified.slice(0, 32_000) + '\n<!-- truncated -->';
    }
    return simplified;
  } catch {
    return '';
  }
}

// ─── Phase 2: Analysis ──────────────────────────────────────

async function analysePage(
  reconOutput: string,
  config: AgentConfig,
): Promise<PlannerResult> {
  try {
    const client = getOpenAI(config);

    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content:
            'Here is the accessibility tree / simplified HTML of a gym schedule page:\n\n' +
            reconOutput,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,  // Low temp for deterministic structured output.
      max_tokens: 500,
    });

    // Track spend.
    const usage = response.usage;
    if (usage) {
      const cost =
        usage.prompt_tokens * INPUT_COST_PER_TOKEN +
        usage.completion_tokens * OUTPUT_COST_PER_TOKEN;
      const costCents = cost * 100;
      cumulativeSpendCents += costCents;
      logger.info(
        `LLM cost: ${costCents.toFixed(4)}¢ ` +
          `(cumulative: ${cumulativeSpendCents.toFixed(2)}¢ / ${config.llmBudgetCents}¢)`,
      );
    }

    // Parse the JSON response.
    const content = response.choices[0]?.message?.content;
    if (!content) {
      logger.warn('LLM returned empty response');
      return emptyPlan();
    }

    const parsed = JSON.parse(content);
    return {
      scheduleSelector: parsed.schedule_selector ?? null,
      nextButtonSelector: parsed.next_button_selector ?? null,
      loadMoreSelector: parsed.load_more_selector ?? null,
      authWallDetected: parsed.auth_wall_detected === true,
    };
  } catch (err) {
    logger.error('LLM analysis failed', err);
    return emptyPlan();
  }
}

// ─── Helpers ────────────────────────────────────────────────

function emptyPlan(): PlannerResult {
  return {
    scheduleSelector: null,
    nextButtonSelector: null,
    loadMoreSelector: null,
    authWallDetected: false,
  };
}

function extractHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
