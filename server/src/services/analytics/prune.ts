/**
 * Analytics retention/prune job. Runs once at startup and then daily.
 *
 *   request  → 7 days   (DELETE WHERE ts < now - 7d)
 *   daily    → 90 days  (DELETE WHERE day < today - 90d)
 *   weekly   → forever
 *   total    → forever
 *
 * `PRAGMA incremental_vacuum` after the request delete returns freed pages to
 * the OS (the DB is opened with auto_vacuum = INCREMENTAL).
 */

import { getAnalyticsDb } from "../../lib/analyticsDb.ts";
import { utcDayNumber } from "./time.ts";

const REQUEST_RETENTION_DAYS = 7;
const DAILY_RETENTION_DAYS = 90;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

let pruneTimer: ReturnType<typeof setInterval> | null = null;

export function runPrune(): void {
  const db = getAnalyticsDb();
  const now = Math.floor(Date.now() / 1000);

  const requestCutoff = now - REQUEST_RETENTION_DAYS * 86400;
  db.prepare("DELETE FROM request WHERE ts < ?").run(requestCutoff);

  const dailyCutoff = utcDayNumber(now - DAILY_RETENTION_DAYS * 86400);
  db.prepare("DELETE FROM daily WHERE day < ?").run(dailyCutoff);

  // Return freed pages to the OS so the file doesn't creep upward.
  db.pragma("incremental_vacuum");
}

/** Start the daily prune job (runs once immediately). */
export function startAnalyticsPrune(): void {
  if (pruneTimer) return;
  const safeRun = () => {
    try {
      runPrune();
    } catch (err) {
      console.error("[analytics] Prune failed:", err);
    }
  };
  safeRun();
  pruneTimer = setInterval(safeRun, PRUNE_INTERVAL_MS);
  pruneTimer.unref?.();
}

/** Stop the prune job (used by tests). */
export function stopAnalyticsPrune(): void {
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
}
