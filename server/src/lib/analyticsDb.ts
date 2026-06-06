/**
 * Analytics database — a dedicated `analytics.db` opened directly with
 * better-sqlite3 (NOT Prisma), in WAL mode.
 *
 * Kept separate from the precious config DB (`sitey.db`): analytics is
 * write-heavy, append-y, and secondary — losing it costs traffic history but
 * never config or uptime. A single shared connection is used by the ingest
 * worker, the prune job, and the read queries; better-sqlite3 is synchronous so
 * all access is naturally serialized on the event loop. See
 * docs/design/analytics.md and docs/design/data-model.md.
 */

import Database from "better-sqlite3";
import path from "node:path";

const DATA_ROOT = process.env.DATA_ROOT ?? "/data";
const ANALYTICS_DB_PATH =
  process.env.ANALYTICS_DB_PATH ?? path.join(DATA_ROOT, "analytics.db");

const SCHEMA_VERSION = 1;

let _db: Database.Database | null = null;

/**
 * Open (or return the already-open) analytics DB connection, bootstrapping the
 * schema on first use. Throws if the file cannot be opened — callers in the
 * background workers catch and log; the read path lets the error surface.
 */
export function getAnalyticsDb(): Database.Database {
  if (_db) return _db;

  const db = new Database(ANALYTICS_DB_PATH);
  // auto_vacuum must be set before any tables exist; harmless on an already
  // initialized file (it simply won't change without a full VACUUM).
  db.pragma("auto_vacuum = INCREMENTAL");
  db.pragma("journal_mode = WAL");
  // Looser durability is fine here — losing the last batch on a power cut is
  // acceptable for best-effort analytics.
  db.pragma("synchronous = NORMAL");

  ensureSchema(db);

  _db = db;
  return db;
}

function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

    -- Detailed tier: one row per HTTP request, rolling ~7 days.
    CREATE TABLE IF NOT EXISTS request (
      id           INTEGER PRIMARY KEY,
      ts           INTEGER NOT NULL,
      service_id   INTEGER NOT NULL,
      host         TEXT    NOT NULL,
      path         TEXT    NOT NULL,
      status       INTEGER NOT NULL,
      method       TEXT,
      content_type TEXT,
      bytes        INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS request_svc_ts ON request (service_id, ts);
    CREATE INDEX IF NOT EXISTS request_ts      ON request (ts);

    -- Daily rollup: ~90 days.
    CREATE TABLE IF NOT EXISTS daily (
      service_id INTEGER NOT NULL,
      day        INTEGER NOT NULL,
      requests   INTEGER NOT NULL DEFAULT 0,
      errors     INTEGER NOT NULL DEFAULT 0,
      bytes      INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (service_id, day)
    );

    -- Weekly rollup: kept forever (tiny).
    CREATE TABLE IF NOT EXISTS weekly (
      service_id INTEGER NOT NULL,
      week       INTEGER NOT NULL,
      requests   INTEGER NOT NULL DEFAULT 0,
      errors     INTEGER NOT NULL DEFAULT 0,
      bytes      INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (service_id, week)
    );

    -- Lifetime tier: forever, one row per service.
    CREATE TABLE IF NOT EXISTS total (
      service_id INTEGER PRIMARY KEY,
      requests   INTEGER NOT NULL DEFAULT 0,
      errors     INTEGER NOT NULL DEFAULT 0,
      bytes      INTEGER NOT NULL DEFAULT 0,
      first_seen INTEGER NOT NULL,
      last_seen  INTEGER NOT NULL
    );
  `);

  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(SCHEMA_VERSION));
}

/** Read a string value from the `meta` key/value table. */
export function readMeta(db: Database.Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

/** Write a string value to the `meta` key/value table. */
export function writeMeta(
  db: Database.Database,
  key: string,
  value: string,
): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}
