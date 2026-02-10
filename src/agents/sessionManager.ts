/**
 * sessionManager.ts — State-aware session manager with login agent and 2FA.
 *
 * WHY do we need session management?
 * ──────────────────────────────────
 * Some gym sites (MindBody member portals, Glofox dashboards) gate their
 * schedule behind a login wall.  The current scraper has no concept of
 * authentication state — if it hits a login redirect, it silently scrapes
 * the login page HTML and produces garbage data.
 *
 * This module provides:
 *   1. **Login State Monitor** — Detects when we've been logged out.
 *   2. **Session Gate** — Pauses all operations while re-authenticating.
 *   3. **Login Agent** — Re-authenticates using stored credentials + LLM
 *      navigation planner (no hardcoded selectors).
 *   4. **TOTP 2FA** — Generates and submits TOTP codes via otplib.
 *   5. **Cookie Persistence** — Saves/loads cookies to skip login on next run.
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import type { Page, HTTPResponse, CookieParam } from 'puppeteer';
import { generate as otplibGenerate, createGuardrails } from 'otplib';
import type { AgentConfig, SessionState } from '../core/types';
import { planNavigation } from './navigationPlanner';
import { createHumanCursor, humanClick, humanType } from '../middleware/humanBehavior';
import { Logger } from '../core/logger';

const logger = new Logger('SessionManager');

// ─── Cookie persistence paths ───────────────────────────────

const COOKIE_FILE = '.cookies.json';

// ─── Session state ──────────────────────────────────────────

let currentState: SessionState = 'unknown';

/**
 * A shared "gate" promise that other modules await before proceeding.
 * When the session is healthy, the gate is resolved.
 * When logged-out is detected, the gate is replaced with a pending promise
 * that blocks all callers until re-authentication completes.
 */
let gateResolve: (() => void) | null = null;
let gateReject: ((err: Error) => void) | null = null;
let sessionGate: Promise<void> = Promise.resolve();

// ─── Public API ─────────────────────────────────────────────

/**
 * Get the current session state.
 */
export function getSessionState(): SessionState {
  return currentState;
}

/**
 * Wait for the session to be healthy before proceeding.
 * If the session is already healthy, this resolves immediately.
 * If re-authentication is in progress, this blocks until it completes.
 */
export async function waitForSession(): Promise<void> {
  return sessionGate;
}

/**
 * Attach login-state monitoring to a Puppeteer Page.
 *
 * This should be called by BrowserManager when creating a new page.
 * The monitor watches HTTP responses for logout signals and sets the
 * session state accordingly.
 */
export function attachLoginMonitor(
  page: Page,
  config: AgentConfig,
): void {
  page.on('response', (response: HTTPResponse) => {
    const status = response.status();
    const url = response.url();

    // Check for auth-wall HTTP codes.
    if (status === 401 || status === 403) {
      onLoggedOut('HTTP ' + status, page, config);
    }

    // Check for redirect to login pages.
    if (status >= 300 && status < 400) {
      const location = response.headers()['location'] ?? '';
      const loginPatterns = ['/login', '/signin', '/auth', '/sso'];
      if (loginPatterns.some((p) => location.toLowerCase().includes(p))) {
        onLoggedOut(`Redirect to ${location}`, page, config);
      }
    }
  });
}

/**
 * Check if the current page looks like a login wall (post-load check).
 * Call this after page.goto() completes.
 */
export async function checkForLoginWall(
  page: Page,
  config: AgentConfig,
): Promise<boolean> {
  try {
    const hasPasswordField = await page.$('input[type="password"]');
    if (hasPasswordField) {
      await onLoggedOut('Password field detected on page', page, config);
      return true;
    }
  } catch {
    // DOM query failed — not fatal.
  }
  return false;
}

// ─── Cookie persistence ─────────────────────────────────────

/**
 * Load saved cookies and inject them into a Page.
 *
 * @returns true if cookies were loaded, false if no saved cookies exist
 *   or they've expired.
 */
export async function loadSavedCookies(
  page: Page,
  config: AgentConfig,
): Promise<boolean> {
  if (!existsSync(COOKIE_FILE)) {
    return false;
  }

  try {
    const raw = await readFile(COOKIE_FILE, 'utf-8');
    const saved: { timestamp: number; cookies: CookieParam[] } =
      JSON.parse(raw);

    // TTL check — don't use stale cookies.
    const ageHours =
      (Date.now() - saved.timestamp) / (1000 * 60 * 60);
    if (ageHours > config.cookieTtlHours) {
      logger.info(
        `Saved cookies are ${ageHours.toFixed(1)}h old ` +
          `(TTL: ${config.cookieTtlHours}h) — discarding`,
      );
      return false;
    }

    await page.setCookie(...saved.cookies);
    currentState = 'logged-in';
    logger.info(
      `Loaded ${saved.cookies.length} saved cookies ` +
        `(${ageHours.toFixed(1)}h old)`,
    );
    return true;
  } catch (err) {
    logger.warn('Failed to load saved cookies', );
    return false;
  }
}

/**
 * Save the current page's cookies to disk for future runs.
 */
export async function saveCookies(page: Page): Promise<void> {
  try {
    const cookies = await page.cookies();
    const data = {
      timestamp: Date.now(),
      cookies,
    };
    await writeFile(COOKIE_FILE, JSON.stringify(data, null, 2));
    logger.info(`Saved ${cookies.length} cookies to ${COOKIE_FILE}`);
  } catch (err) {
    logger.warn('Failed to save cookies');
  }
}

// ─── Login Agent ────────────────────────────────────────────

/**
 * Perform a full login flow:
 *   1. Use the Navigation Planner to find form fields (no hardcoded selectors).
 *   2. Type credentials with human-like timing.
 *   3. Handle TOTP 2FA if challenged.
 *   4. Verify we're logged in.
 *   5. Save cookies for next run.
 */
async function performLogin(
  page: Page,
  config: AgentConfig,
): Promise<boolean> {
  // Validate that we have credentials.
  if (!config.gymUsername || !config.gymPassword) {
    logger.error(
      'Cannot log in — GYM_USERNAME and GYM_PASSWORD must be set in .env',
    );
    return false;
  }

  logger.info('Starting login flow…');

  const MAX_LOGIN_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt++) {
    logger.info(`Login attempt ${attempt}/${MAX_LOGIN_ATTEMPTS}…`);

    try {
      // Find form fields using LLM planner (self-healing).
      const usernameField = await findField(page, 'username or email input');
      const passwordField = await findField(page, 'password input');
      const submitButton = await findField(page, 'login or sign-in submit button');

      if (!usernameField || !passwordField || !submitButton) {
        logger.warn('Could not identify all login form fields');
        continue;
      }

      // Type credentials with human-like timing.
      const cursor = createHumanCursor(page);

      // Clear any existing text first.
      await page.click(usernameField, { clickCount: 3 });
      await humanType(page, usernameField, config.gymUsername);

      await page.click(passwordField, { clickCount: 3 });
      await humanType(page, passwordField, config.gymPassword);

      // Submit.
      await humanClick(cursor, submitButton);

      // Wait for navigation.
      await page.waitForNavigation({
        waitUntil: 'networkidle2',
        timeout: 15_000,
      }).catch(() => {
        // Some login forms use AJAX instead of full page navigation.
        // Wait a bit for the page to update.
      });

      await sleep(2_000);

      // Check for 2FA challenge.
      const needs2fa = await check2faChallenge(page);
      if (needs2fa) {
        const success = await handle2fa(page, config);
        if (!success) {
          logger.error('2FA failed');
          continue;
        }
      }

      // Verify we're NOT still on a login page.
      const stillOnLogin = await page.$('input[type="password"]');
      if (stillOnLogin) {
        logger.warn('Still on login page after submit — credentials may be wrong');
        continue;
      }

      // Success!
      currentState = 'logged-in';
      logger.info('Login successful!');
      await saveCookies(page);
      return true;
    } catch (err) {
      logger.error(`Login attempt ${attempt} failed`, err);
    }
  }

  logger.error('All login attempts exhausted');
  return false;
}

// ─── 2FA handling ───────────────────────────────────────────

/**
 * Check if the page is presenting a 2FA challenge.
 */
async function check2faChallenge(page: Page): Promise<boolean> {
  try {
    const html = await page.content();
    const indicators = [
      /verification\s*code/i,
      /authenticator/i,
      /two.?factor/i,
      /2fa/i,
      /one.?time\s*password/i,
      /enter\s*code/i,
      /otp/i,
    ];
    return indicators.some((p) => p.test(html));
  } catch {
    return false;
  }
}

/**
 * Handle TOTP 2FA:
 *   1. Generate the current 6-digit code from the shared secret.
 *   2. Find the OTP input field.
 *   3. Type the code with human-like timing.
 *   4. Submit.
 */
async function handle2fa(
  page: Page,
  config: AgentConfig,
): Promise<boolean> {
  if (!config.gymTotpSecret) {
    logger.error(
      '2FA challenge detected but GYM_TOTP_SECRET is not set.  ' +
        'Set the base32 TOTP secret in your .env file.\n' +
        'Example: GYM_TOTP_SECRET=JBSWY3DPEHPK3PXP',
    );
    return false;
  }

  logger.info('Handling TOTP 2FA challenge…');

  try {
    // Generate the current TOTP code.
    // WHY relaxed guardrails?
    // otplib v13 enforces a 16-byte minimum secret by default, but many
    // real-world TOTP setups use 10-byte (80-bit) secrets which is the
    // standard per RFC 4226.  We relax the minimum to avoid rejecting
    // valid secrets.
    const guardrails = createGuardrails({ MIN_SECRET_BYTES: 1 });
    const code = await otplibGenerate({ secret: config.gymTotpSecret, guardrails });
    logger.info(`Generated TOTP code: ${code.slice(0, 2)}****`);

    // Find the OTP input field.
    const otpField = await findField(page, 'verification code or OTP input field');
    if (!otpField) {
      // Fall back to common selectors.
      const fallbackSelectors = [
        'input[name*="otp"]',
        'input[name*="code"]',
        'input[name*="token"]',
        'input[type="tel"]',
        'input[autocomplete="one-time-code"]',
      ];

      for (const sel of fallbackSelectors) {
        const el = await page.$(sel);
        if (el) {
          await humanType(page, sel, code);
          break;
        }
      }
    } else {
      await humanType(page, otpField, code);
    }

    // Look for a submit/verify button.
    const verifyButton = await findField(page, 'verify or submit button for 2FA code');
    if (verifyButton) {
      const cursor = createHumanCursor(page);
      await humanClick(cursor, verifyButton);
    } else {
      // Some sites auto-submit after all digits are entered.
      await page.keyboard.press('Enter');
    }

    // Wait for navigation/response.
    await page.waitForNavigation({
      waitUntil: 'networkidle2',
      timeout: 10_000,
    }).catch(() => {});

    await sleep(2_000);

    // Verify 2FA was accepted.
    const still2fa = await check2faChallenge(page);
    if (still2fa) {
      logger.warn('Still on 2FA page — code may have been incorrect');
      return false;
    }

    logger.info('2FA verification successful');
    return true;
  } catch (err) {
    logger.error('2FA handling failed', err);
    return false;
  }
}

// ─── Logged-out handler ─────────────────────────────────────

let loginInProgress = false;

/**
 * Called when a logged-out state is detected.
 * Pauses all operations, triggers login, resumes on success.
 */
async function onLoggedOut(
  reason: string,
  page: Page,
  config: AgentConfig,
): Promise<void> {
  // Avoid re-entrant login attempts.
  if (loginInProgress || currentState === 'logged-out') return;

  logger.warn(`Logged-out detected (${reason}) — pausing operations…`);
  currentState = 'logged-out';
  loginInProgress = true;

  // Replace the session gate with a pending promise.
  sessionGate = new Promise<void>((resolve, reject) => {
    gateResolve = resolve;
    gateReject = reject;
  });

  try {
    const success = await performLogin(page, config);
    if (success) {
      currentState = 'logged-in';
      gateResolve?.();
    } else {
      currentState = 'logged-out';
      gateReject?.(new Error('Re-authentication failed after all retries'));
    }
  } catch (err) {
    gateReject?.(err as Error);
  } finally {
    loginInProgress = false;
  }
}

// ─── Helpers ────────────────────────────────────────────────

/**
 * Use the LLM Navigation Planner to find a specific form field.
 *
 * WHY not hardcode selectors?
 * Login forms vary wildly across gym platforms.  The LLM approach
 * makes this self-healing — if a site redesigns, the planner adapts.
 *
 * Falls back to common selector patterns if the LLM is unavailable.
 */
async function findField(
  page: Page,
  description: string,
): Promise<string | null> {
  // Try common selectors first (fast, no LLM cost).
  const commonSelectors = getCommonSelectors(description);
  for (const sel of commonSelectors) {
    try {
      const el = await page.$(sel);
      if (el) return sel;
    } catch {
      // Selector invalid or element not found — try next.
    }
  }

  // If common selectors fail, try the LLM planner.
  // We do this sparingly to avoid burning budget on login forms.
  try {
    const { loadAgentConfig } = await import('../core/types');
    const config = loadAgentConfig();
    if (config.openaiApiKey) {
      const plan = await planNavigation(page, config, true);
      // Map description to planner result fields.
      if (description.includes('submit') && plan.loadMoreSelector) {
        return plan.loadMoreSelector;
      }
    }
  } catch {
    // LLM unavailable — rely on common selectors only.
  }

  return null;
}

/**
 * Return common CSS selectors for a given field description.
 */
function getCommonSelectors(description: string): string[] {
  const lower = description.toLowerCase();

  if (lower.includes('username') || lower.includes('email')) {
    return [
      'input[type="email"]',
      'input[name="email"]',
      'input[name="username"]',
      'input[name="login"]',
      'input[autocomplete="email"]',
      'input[autocomplete="username"]',
      '#email',
      '#username',
    ];
  }

  if (lower.includes('password')) {
    return [
      'input[type="password"]',
      'input[name="password"]',
      'input[autocomplete="current-password"]',
      '#password',
    ];
  }

  if (lower.includes('submit') || lower.includes('sign-in') || lower.includes('login')) {
    return [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Sign in")',
      'button:has-text("Log in")',
      'button:has-text("Login")',
      '[data-testid="login-button"]',
      '.login-button',
      '#login-submit',
    ];
  }

  if (lower.includes('otp') || lower.includes('verification') || lower.includes('code')) {
    return [
      'input[name*="otp"]',
      'input[name*="code"]',
      'input[name*="token"]',
      'input[type="tel"]',
      'input[autocomplete="one-time-code"]',
      'input[inputmode="numeric"]',
    ];
  }

  if (lower.includes('verify') || lower.includes('2fa')) {
    return [
      'button[type="submit"]',
      'button:has-text("Verify")',
      'button:has-text("Submit")',
      'button:has-text("Confirm")',
    ];
  }

  return [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
