/**
 * logger.ts — Natural-language progress logger for the scraping pipeline.
 *
 * WHY a custom logger instead of console.log?
 * ────────────────────────────────────────────
 * 1. **Readability for operators:**  Messages like "Found 3 locations for SoulCycle"
 *    are far easier to scan than raw JSON or stack traces during a scraping run.
 * 2. **Consistent format:**  Every message carries a timestamp and level so you can
 *    pipe output to a file or structured logging service without extra wrappers.
 * 3. **Single place to enhance:**  When you later add Sentry, Datadog, or Slack
 *    alerts you only touch this file — every caller already uses `logger.info()`.
 */

export type LogLevel = 'info' | 'warn' | 'error';

/**
 * Lightweight logger that emits human-readable, timestamped messages.
 *
 * Usage:
 *   const logger = new Logger('GymScanner');
 *   logger.info('Found 15 classes for SoulCycle, preparing batch upsert…');
 */
export class Logger {
  /** A label prepended to every message so you can tell *which* module is talking. */
  private readonly context: string;

  constructor(context: string) {
    this.context = context;
  }

  // ── Public API ─────────────────────────────────────────

  /** Routine progress: page fetched, classes found, upsert complete. */
  info(message: string): void {
    this.emit('info', message);
  }

  /** Something unexpected but non-fatal: missing timezone, empty schedule table. */
  warn(message: string): void {
    this.emit('warn', message);
  }

  /** A hard failure: browser crash, Supabase 500, etc. */
  error(message: string, err?: unknown): void {
    this.emit('error', message);
    // WHY log the raw error separately?
    // The natural-language message is for humans; the raw error object
    // is for engineers debugging the root cause.
    if (err) {
      console.error(err);
    }
  }

  // ── Internals ──────────────────────────────────────────

  /**
   * Formats and writes a single log line.
   *
   * WHY this format?
   * `[2026-02-10T18:30:00Z] [INFO] [GymScanner] Found 3 locations…`
   * — ISO timestamp for machine parsing, uppercase level for quick visual scanning,
   *   context label so multi-module logs stay readable.
   */
  private emit(level: LogLevel, message: string): void {
    const timestamp = new Date().toISOString();
    const tag = level.toUpperCase().padEnd(5); // "INFO " / "WARN " / "ERROR"
    const line = `[${timestamp}] [${tag}] [${this.context}] ${message}`;

    switch (level) {
      case 'error':
        console.error(line);
        break;
      case 'warn':
        console.warn(line);
        break;
      default:
        console.log(line);
    }
  }
}
