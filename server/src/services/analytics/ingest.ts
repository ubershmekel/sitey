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
import { UNKNOWN_SERVICE_ID } from "../../lib/constants.ts";
import { utcDayNumber, isoYearWeek } from "./time.ts";

const ACCESS_LOG_PATH =
  process.env.CADDY_ACCESS_LOG ?? "/var/log/caddy/access.log";
const POLL_MS = 2000;
const READ_CHUNK = 64 * 1024;
// Lines flushed per transaction. A backlog (cold start over an existing log, or
// catch-up after downtime) is committed in chunks of this size, yielding to the
// event loop between them, rather than one giant synchronous transaction.
const BATCH_SIZE = 500;
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
// Re-entrancy guard: a single poll may run long while draining a backlog, so we
// must not let the interval start another on top of it (shared DB connection).
let polling = false;

// ── Parsing ───────────────────────────────────────────────────────────────

/**
 * Parse one Caddy access-log line into a ParsedRequest. Returns null ONLY when
 * the line carries no request to count — an empty line or non-JSON corruption
 * (a complete line that won't parse; partial trailing lines never reach here,
 * they wait in the `partial` buffer). We never drop a real request line for a
 * missing/unattributable field: an absent or non-numeric `service_id` falls back
 * to the "Requests without service ID" bucket (UNKNOWN_SERVICE_ID = 0, surfaced as
 * "Unknown" in the UI) and a missing `ts` to ingest time, so "don't-lose-data"
 * holds even if some future Caddy block emits an untagged line. Exported for
 * testing.
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

  const serviceIdRaw = Number((entry as { service_id?: unknown }).service_id);
  const serviceId = Number.isFinite(serviceIdRaw)
    ? serviceIdRaw
    : UNKNOWN_SERVICE_ID;

  const tsRaw = Math.floor(Number((entry as { ts?: unknown }).ts));
  const ts = Number.isFinite(tsRaw) ? tsRaw : Math.floor(Date.now() / 1000);

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

  // Content-Type is the only field we read from the response headers (status and
  // size are top-level). `resp_headers` is therefore intentionally KEPT in the
  // Caddy access log (see appendRequestsLogSnippet in caddy.ts) — but only the
  // bare MIME type is ever stored; no other response header is persisted, and
  // Caddy redacts Set-Cookie/Authorization by default (we also delete Set-Cookie
  // explicitly in the log filter as defense-in-depth).
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
    // Save only up to the last COMPLETE line parsed — which, at every point we
    // call this, is also the last line we've FLUSHED. Bytes still in `partial`
    // are an incomplete trailing fragment that gets re-read next poll. Keeping
    // the saved offset aligned with committed data means a crash or restart
    // mid-drain never double-counts a batch we already committed (counters are
    // incremental upserts) nor skips one we hadn't.
    offset: offset - partial.length,
  };
  writeMeta(getAnalyticsDb(), TAIL_STATE_KEY, JSON.stringify(state));
}

/** Yield control to the event loop so a long backlog drain stays responsive. */
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
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
 * Read from the open fd starting at `offset` up to current EOF, parsing complete
 * lines and flushing them in bounded batches (`BATCH_SIZE`) — each its own
 * transaction, yielding to the event loop between them. This keeps a large
 * backlog (cold start over a ~20MB rolled log, or catch-up after downtime) from
 * blocking the event loop in one giant synchronous transaction or buffering the
 * whole file in memory. The saved offset is advanced per committed batch (see
 * persistTailState), so a crash mid-drain neither loses a batch nor re-ingests
 * one already committed. Any trailing partial line stays in `partial`.
 */
async function drainOpenFd(): Promise<void> {
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
  let batch: ParsedRequest[] = [];
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
      if (parsed) batch.push(parsed);
      if (batch.length >= BATCH_SIZE) {
        getStatements().flush(batch);
        batch = [];
        // Commit point: the last flushed line ends exactly at
        // `offset - partial.length`, so persisting here is crash-safe.
        persistTailState();
        await yieldToLoop();
      }
    }
  }
  if (batch.length > 0) {
    getStatements().flush(batch);
    persistTailState();
  }
}

async function poll(): Promise<void> {
  // 1. Drain whatever we already had open (the tail of a file that may have
  //    just been rolled out from under us). Flushes in batches internally.
  await drainOpenFd();

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
      await drainOpenFd();
    }
  }

  // Persist the trailing offset even when nothing flushed this tick, so a
  // restart resumes at the last committed line rather than re-scanning.
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
    // Skip if the previous poll is still draining a backlog — never overlap
    // polls on the shared connection.
    if (polling) return;
    polling = true;
    poll()
      .catch((err) => {
        // Never let ingest throw into the process; drop the batch and continue.
        console.error("[analytics] Ingest poll failed:", err);
      })
      .finally(() => {
        polling = false;
      });
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
  polling = false;
  closeOpenFd();
  offset = 0;
  partial = Buffer.alloc(0);
  statements = null;
}
