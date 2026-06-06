/**
 * Analytics ingest worker — tails Caddy's rolled JSON access log and folds each
 * line into the analytics counters.
 *
 * Principles (see docs/design/analytics.md):
 *  - Off the request path: Caddy serves directly; this is pure background I/O.
 *  - Best-effort: a batch may be lost on crash/rotation; that's acceptable.
 *  - Rotation-safe: the open file is tracked by identity (dev + ino), never by
 *    size, so a roll can't make us seek into the middle of a fresh file.
 */

import fs from "node:fs";
import { getAnalyticsDb, readMeta, writeMeta } from "../../lib/analyticsDb.ts";
import { utcDayNumber, isoYearWeek } from "./time.ts";

const ACCESS_LOG_PATH =
  process.env.CADDY_ACCESS_LOG ?? "/var/log/caddy/access.log";
const POLL_MS = 2000;
const READ_CHUNK = 64 * 1024;
const PATH_MAX = 128;
const TAIL_STATE_KEY = "tail_state";

type ParsedRequest = {
  ts: number;
  serviceId: number;
  host: string;
  path: string;
  status: number;
  method: string | null;
  contentType: string | null;
  bytes: number;
};

type TailState = { dev: number; ino: number; offset: number };

// In-memory tail position. Persisted to `meta` after each batch so a restart
// resumes where it left off (only if the file identity still matches).
let openFd: number | null = null;
let openIdentity: { dev: number; ino: number } | null = null;
let offset = 0;
// Bytes read but not yet forming a complete line. Kept as a Buffer (not a
// string) so a multibyte UTF-8 char split across two reads isn't corrupted.
let partial: Buffer = Buffer.alloc(0);
let pollTimer: ReturnType<typeof setInterval> | null = null;

// ── Parsing ───────────────────────────────────────────────────────────────

/**
 * Parse one Caddy access-log line into a ParsedRequest, or null if it should be
 * skipped (malformed JSON, missing/invalid `service_id`, or no timestamp).
 * Exported for testing.
 */
export function parseLine(line: string): ParsedRequest | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!entry || typeof entry !== "object") return null;

  const serviceId = Number((entry as { service_id?: unknown }).service_id);
  if (!Number.isFinite(serviceId)) return null;

  const ts = Math.floor(Number((entry as { ts?: unknown }).ts));
  if (!Number.isFinite(ts)) return null;

  const request = (entry.request ?? {}) as Record<string, unknown>;

  const host = String(request.host ?? "")
    .toLowerCase()
    .slice(0, PATH_MAX);

  let path = String(request.uri ?? "");
  const q = path.indexOf("?");
  if (q >= 0) path = path.slice(0, q);
  path = path.slice(0, PATH_MAX);

  const status = Number((entry as { status?: unknown }).status) || 0;
  const method = request.method ? String(request.method) : null;

  let contentType: string | null = null;
  const respHeaders = (entry as { resp_headers?: Record<string, unknown> })
    .resp_headers;
  const ctRaw =
    respHeaders && (respHeaders["Content-Type"] ?? respHeaders["content-type"]);
  if (Array.isArray(ctRaw) && ctRaw.length > 0) {
    const bare = String(ctRaw[0]).split(";")[0].trim().toLowerCase();
    contentType = bare || null;
  }

  const bytes = Number((entry as { size?: unknown }).size) || 0;

  return { ts, serviceId, host, path, status, method, contentType, bytes };
}

// ── Persistence ─────────────────────────────────────────────────────────────

type Statements = {
  insertRequest: import("better-sqlite3").Statement;
  upsertDaily: import("better-sqlite3").Statement;
  upsertWeekly: import("better-sqlite3").Statement;
  upsertTotal: import("better-sqlite3").Statement;
  flush: (rows: ParsedRequest[]) => void;
};

let statements: Statements | null = null;

function getStatements(): Statements {
  if (statements) return statements;
  const db = getAnalyticsDb();

  const insertRequest = db.prepare(
    `INSERT INTO request
       (ts, service_id, host, path, status, method, content_type, bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const upsertDaily = db.prepare(
    `INSERT INTO daily (service_id, day, requests, errors, bytes)
     VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(service_id, day) DO UPDATE SET
       requests = requests + 1,
       errors   = errors + excluded.errors,
       bytes    = bytes + excluded.bytes`,
  );
  const upsertWeekly = db.prepare(
    `INSERT INTO weekly (service_id, week, requests, errors, bytes)
     VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(service_id, week) DO UPDATE SET
       requests = requests + 1,
       errors   = errors + excluded.errors,
       bytes    = bytes + excluded.bytes`,
  );
  const upsertTotal = db.prepare(
    `INSERT INTO total (service_id, requests, errors, bytes, first_seen, last_seen)
     VALUES (?, 1, ?, ?, ?, ?)
     ON CONFLICT(service_id) DO UPDATE SET
       requests   = requests + 1,
       errors     = errors + excluded.errors,
       bytes      = bytes + excluded.bytes,
       first_seen = min(first_seen, excluded.first_seen),
       last_seen  = max(last_seen, excluded.last_seen)`,
  );

  const flush = db.transaction((rows: ParsedRequest[]) => {
    for (const r of rows) {
      const err = r.status >= 500 ? 1 : 0;
      insertRequest.run(
        r.ts,
        r.serviceId,
        r.host,
        r.path,
        r.status,
        r.method,
        r.contentType,
        r.bytes,
      );
      upsertDaily.run(r.serviceId, utcDayNumber(r.ts), err, r.bytes);
      upsertWeekly.run(r.serviceId, isoYearWeek(r.ts), err, r.bytes);
      upsertTotal.run(r.serviceId, err, r.bytes, r.ts, r.ts);
    }
  });

  statements = { insertRequest, upsertDaily, upsertWeekly, upsertTotal, flush };
  return statements;
}

function persistTailState(): void {
  if (!openIdentity) return;
  const state: TailState = {
    dev: openIdentity.dev,
    ino: openIdentity.ino,
    offset,
  };
  writeMeta(getAnalyticsDb(), TAIL_STATE_KEY, JSON.stringify(state));
}

// ── Tailing ───────────────────────────────────────────────────────────────

function closeOpenFd(): void {
  if (openFd !== null) {
    try {
      fs.closeSync(openFd);
    } catch {
      // ignore
    }
  }
  openFd = null;
  openIdentity = null;
}

/** Open the access-log path fresh, resetting to the given offset. */
function openPath(startOffset: number): void {
  closeOpenFd();
  const fd = fs.openSync(ACCESS_LOG_PATH, "r");
  const st = fs.fstatSync(fd);
  openFd = fd;
  openIdentity = { dev: st.dev, ino: st.ino };
  offset = startOffset;
  partial = Buffer.alloc(0);
}

/**
 * Read from the open fd starting at `offset` up to current EOF, splitting into
 * complete lines and appending parsed rows to `out`. Leaves any trailing
 * partial line in the module-level `partial` buffer.
 */
function drainOpenFd(out: ParsedRequest[]): void {
  if (openFd === null) return;
  let size: number;
  try {
    size = fs.fstatSync(openFd).size;
  } catch {
    return;
  }
  // File shrank under us (truncate/replace with same identity) — restart it.
  if (size < offset) {
    offset = 0;
    partial = Buffer.alloc(0);
  }
  while (offset < size) {
    const want = Math.min(READ_CHUNK, size - offset);
    const chunk = Buffer.allocUnsafe(want);
    let read: number;
    try {
      read = fs.readSync(openFd, chunk, 0, want, offset);
    } catch {
      break;
    }
    if (read <= 0) break;
    offset += read;
    partial =
      partial.length === 0
        ? chunk.subarray(0, read)
        : Buffer.concat([partial, chunk.subarray(0, read)]);

    let nl: number;
    while ((nl = partial.indexOf(0x0a)) >= 0) {
      const line = partial.subarray(0, nl).toString("utf8");
      partial = partial.subarray(nl + 1);
      const parsed = parseLine(line);
      if (parsed) out.push(parsed);
    }
  }
}

function poll(): void {
  const rows: ParsedRequest[] = [];

  // 1. Drain whatever we already had open (the tail of a file that may have
  //    just been rolled out from under us).
  drainOpenFd(rows);

  // 2. Detect a roll (or first open) by comparing the path's identity to the
  //    open handle's.
  let pathStat: fs.Stats | null = null;
  try {
    pathStat = fs.statSync(ACCESS_LOG_PATH);
  } catch {
    pathStat = null; // file doesn't exist yet (fresh install / dev w/o Caddy)
  }

  if (pathStat) {
    const rolled =
      openIdentity === null ||
      pathStat.ino !== openIdentity.ino ||
      pathStat.dev !== openIdentity.dev;
    if (rolled) {
      openPath(0);
      drainOpenFd(rows);
    }
  }

  if (rows.length > 0) {
    getStatements().flush(rows);
  }
  // Persist offset even with no rows so a restart doesn't re-scan the file.
  if (openIdentity) persistTailState();
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

/**
 * Initialize the tail position from persisted state. Only reuse the saved
 * offset if the on-disk file identity still matches; otherwise start at 0.
 */
function init(): void {
  let saved: TailState | null = null;
  try {
    const raw = readMeta(getAnalyticsDb(), TAIL_STATE_KEY);
    if (raw) saved = JSON.parse(raw) as TailState;
  } catch {
    saved = null;
  }

  let st: fs.Stats | null = null;
  try {
    st = fs.statSync(ACCESS_LOG_PATH);
  } catch {
    st = null;
  }
  if (!st) return; // nothing to open yet — poll() will pick it up later

  if (saved && saved.ino === st.ino && saved.dev === st.dev) {
    openPath(saved.offset);
  } else {
    openPath(0);
  }
}

/** Start the background ingest worker. Safe to call once at startup. */
export function startAnalyticsIngest(): void {
  if (pollTimer) return;
  try {
    getAnalyticsDb();
  } catch (err) {
    console.error("[analytics] Failed to open analytics DB:", err);
    return;
  }

  try {
    init();
  } catch (err) {
    console.error("[analytics] Ingest init failed:", err);
  }

  pollTimer = setInterval(() => {
    try {
      poll();
    } catch (err) {
      // Never let ingest throw into the process; drop the batch and continue.
      console.error("[analytics] Ingest poll failed:", err);
    }
  }, POLL_MS);
  // Don't keep the event loop alive solely for analytics.
  pollTimer.unref?.();

  console.log(`[analytics] Ingest worker tailing ${ACCESS_LOG_PATH}`);
}

/**
 * Test-only: parse and flush a batch of raw log lines through the real prepared
 * statements (exercises the actual insert/upsert SQL). Returns rows ingested.
 */
export function ingestLinesForTest(lines: string[]): number {
  const rows = lines
    .map(parseLine)
    .filter((r): r is ParsedRequest => r !== null);
  if (rows.length > 0) getStatements().flush(rows);
  return rows.length;
}

/** Stop the worker (used by tests). */
export function stopAnalyticsIngest(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  closeOpenFd();
  offset = 0;
  partial = Buffer.alloc(0);
  statements = null;
}
