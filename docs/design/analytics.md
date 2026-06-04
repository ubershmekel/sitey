# Analytics (page views)

Lightweight, best-effort page-view analytics per service. The goal is to answer
three questions on a service's detail page without charts or configuration:

- How many page views has this service had **all time**?
- How many in the **past week**?
- Is something wrong — a **dead** site (views → 0), a **spike**, or a **common
  error** at some URL/host?

Non-goals (for now): real-time dashboards, charts, per-visitor sessions, unique
visitors, geo, referrers, retention/funnels, billing-grade accuracy, or any
user-facing configuration. Sane defaults only.

## Principles

1. **Never slow down serving.** Static sites and proxied apps are served by
   Caddy directly — sitey-api is not on the request path. Analytics must stay
   off that path too: Caddy logs asynchronously, sitey-api ingests out-of-band.
2. **Bounded disk, forever.** Detailed data is short-lived; only small rollups
   live long. A 1M-views/month site must not grow the disk without bound.
3. **Best-effort, not exact.** We may lose a batch on crash or rotation. That's
   fine — these numbers drive intuition, not invoices. State this plainly in the
   UI ("approximate").
4. **Decoupled from config.** Analytics is disposable; the config DB is not.
   Wiping analytics must never risk a domain, service, or cert.

## Data flow

```
 visitor ──HTTP──▶ Caddy ──serves response──▶ visitor
                    │
                    │ access log (JSON, async, rolled)
                    ▼
        $DATA_ROOT/caddy-logs/access.log
                    │
                    │ tail (follow from saved offset)
                    ▼
        sitey-api  ingest worker  ──batched txn──▶ analytics.db
                    │                                 │
              parse + map host/path → serviceId       ├─ event     (7 days)
                                                       ├─ daily     (90 days)
                                                       ├─ weekly    (forever)
                                                       └─ total     (forever)
```

The user's request never touches sitey-api or analytics.db. Caddy appends a line
to a rolled log file; sitey-api tails that file and folds it into counters in a
separate SQLite database.

## 1. Getting page views out of Caddy

Caddy emits a structured JSON access log per request. sitey-api already
generates the whole Caddyfile (`server/src/services/caddy.ts`), so we extend the
generator rather than hand-editing config.

### Log output

Add a shared, **writable** log directory and point Caddy's access log at it with
rolling enabled so the raw file is self-capping:

`deploy/docker-compose.yml` — caddy service:

```yaml
volumes:
  - ${DATA_ROOT:-./data}/caddy-logs:/var/log/caddy # writable
```

`deploy/docker-compose.yml` — sitey-api service:

```yaml
volumes:
  - ${DATA_ROOT:-./data}/caddy-logs:/var/log/caddy:ro # read-only tail
```

In each generated **user** site block (not the management block — see Mapping),
emit:

```caddyfile
    log {
        output file /var/log/caddy/access.log {
            roll_size 20mb
            roll_keep 3
            roll_keep_for 168h
        }
        format json
    }
```

A single shared `access.log` (rather than one file per site) keeps the tailer
simple — one file, one offset. `roll_size`/`roll_keep` bound the raw file to
~60MB regardless of traffic; once ingested we don't need the raw lines.

### Mapping a request → service

A log line gives us `host` and `uri`; we need a `serviceId`. Two options:

**Primary — `log_append` (Caddy ≥ 2.9, which `caddy:alpine` already is).**
Inside each route's `handle`/`handle_path` block (where `appendRouteHandler`
already writes the handler), append a constant field:

```caddyfile
        log_append service_id 42
```

Then ingestion reads `service_id` straight from the JSON line — no re-matching,
correct even for path-prefix routes that fan multiple services onto one host.
This is the recommended approach.

**Fallback — host/path resolution at ingest.** If we ever can't tag, sitey-api
keeps an in-memory routing table (host + path-prefix → serviceId), rebuilt on
every Caddy reload (we already rebuild routing state there), and matches each
line. More code, duplicates Caddy's matching semantics (wildcards, longest
prefix); only worth it if `log_append` becomes unavailable.

Lines with no resolvable service (the management UI, probes, unmatched hosts)
are recorded with `service_id = NULL` or dropped — we don't surface them per
service. The management/admin block deliberately gets **no** `log` directive so
control-panel traffic isn't counted as a "site".

## 2. Ingestion

A single background worker in sitey-api, started in `main()` alongside the
initial Caddy reload.

- **Tail.** Open `access.log`, seek to the saved byte offset (from `meta`), read
  new lines as they arrive. Persist the offset after each successful batch.
- **Rotation.** On each poll, stat the file; if its size is **smaller** than the
  saved offset, Caddy rolled it — reset offset to 0 and re-open. (We accept that
  lines written to the old file between roll and detection are lost — best
  effort.)
- **Parse.** JSON per line; pull `ts`, `request.host`, `request.uri`, `status`,
  `request.method`, and `service_id`.
- **Normalize the path.** Strip the query string, lowercase the host, and
  **truncate the path** to ~128 chars. This caps `event` row size and path
  cardinality (the long tail of `?cache-bust=…` URLs collapses).
- **Batch.** Buffer in memory; flush every ~2s or every ~500 lines, whichever
  first, inside **one transaction**: insert into `event` and upsert the `daily`,
  `weekly`, and `total` counters in the same txn. Counters are maintained
  incrementally so pruning `event` later never disturbs them.
- **Isolation.** All of this runs on the analytics DB connection only. Any error
  logs and drops the batch — it must never throw into request handling or touch
  the config DB.

Because static-site and proxy traffic is served entirely by Caddy, this worker
adds **zero latency** to page loads — it's pure background I/O.

## 3. Storage: a separate SQLite file

**Decision: a dedicated `analytics.db`, opened with `better-sqlite3` directly
(not Prisma), in WAL mode.**

Why separate from the main config DB:

- **Different durability.** Config is precious; analytics is disposable and
  rebuildable. Deleting `analytics.db` must be a safe, supported recovery move.
- **Write pattern.** Analytics is write-heavy and append-y; config is
  read-mostly and transactional. Isolating them avoids write contention and lets
  analytics run `synchronous = NORMAL` (faster, "lose the last batch on a power
  cut" — acceptable) while config stays durable.
- **WAL** lets the ingest worker write while the API reads for the UI without
  blocking.
- **Not Prisma.** Keeping it on a thin raw `better-sqlite3` connection avoids a
  second Prisma schema/generator and keeps the hot insert path allocation-light.
  A tiny hand-rolled `CREATE TABLE IF NOT EXISTS` migration (versioned in
  `meta`) is enough.

Location: `/data/analytics.db` (next to `sitey.db`, inside the bind-mounted data
root). Alternatives considered are listed at the end.

### Schema

```sql
-- Detailed tier: rolling ~7 days. Drill-down for error/URL questions.
CREATE TABLE event (
  id         INTEGER PRIMARY KEY,
  ts         INTEGER NOT NULL,        -- unix seconds
  service_id INTEGER,                 -- NULL = unmatched / management
  host       TEXT    NOT NULL,
  path       TEXT    NOT NULL,        -- query stripped, truncated to ~128
  status     INTEGER NOT NULL,
  method     TEXT
);
CREATE INDEX event_svc_ts ON event (service_id, ts);
CREATE INDEX event_ts     ON event (ts);

-- Daily rollup: ~90 days. Powers "past week" and spike/dead detection cheaply.
CREATE TABLE daily (
  service_id INTEGER NOT NULL,
  day        INTEGER NOT NULL,        -- yyyymmdd
  views      INTEGER NOT NULL DEFAULT 0,
  errors     INTEGER NOT NULL DEFAULT 0,  -- status >= 400
  PRIMARY KEY (service_id, day)
);

-- Weekly rollup: kept forever (tiny — ~52 rows/service/year).
CREATE TABLE weekly (
  service_id INTEGER NOT NULL,
  week       INTEGER NOT NULL,        -- ISO year-week, e.g. 202623
  views      INTEGER NOT NULL DEFAULT 0,
  errors     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (service_id, week)
);

-- Lifetime tier: forever, one row per service.
CREATE TABLE total (
  service_id INTEGER PRIMARY KEY,
  views      INTEGER NOT NULL DEFAULT 0,
  errors     INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);

-- Worker state + schema version.
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
```

This mirrors exactly the tiering described in the request: **a week of detailed
logs, then a per-service weekly number, plus an all-time sum.** `daily` is the
middle workhorse — granular enough to spot a spike or a site going dead, small
enough to keep for 90 days. The detailed `event` tier exists only so we can
answer "which URL is erroring" / "what's the common 500" for the last week.

### Retention & pruning

One cheap maintenance job, run daily (and once at startup):

| Tier     | Retention | Pruning                                     |
| -------- | --------- | ------------------------------------------- |
| `event`  | 7 days    | `DELETE FROM event WHERE ts < now - 7d`     |
| `daily`  | 90 days   | `DELETE FROM daily WHERE day < today - 90d` |
| `weekly` | forever   | none (≈52 rows/service/year)                |
| `total`  | forever   | none (1 row/service)                        |

Run `PRAGMA incremental_vacuum` (DB opened with `auto_vacuum = INCREMENTAL`)
after the `event` delete so freed pages return to the OS and the file doesn't
creep upward.

### Disk budget (worst case: 1M views/month single service)

- ~33k events/day → ~230k rows for the 7-day window. At ~150 bytes/row ≈
  **~35MB**.
- Rolled raw `access.log` ≈ **up to ~60MB** (capped by `roll_size`×`roll_keep`).
- `daily`: 90 rows. `weekly`: ~52/year. `total`: 1 row. → **kilobytes**.

So a very busy site costs ~100MB of bounded, self-pruning disk; a quiet site
costs almost nothing. Many sites scale linearly in the event tier only, which is
the part we aggressively prune.

## 4. Surfacing it

A new tRPC router `analytics` (read-only, `settledProcedure`) reading
`analytics.db`:

- `analytics.forService({ serviceId })` →
  `{ totalViews, last7dViews, last7dErrors, topErrorPaths? }`
  - `totalViews` ← `total.views`.
  - `last7dViews`/`last7dErrors` ← sum over `daily` for the last 7 days (cheap,
    survives `event` pruning).
  - `topErrorPaths` (optional) ← from `event` for the last 7 days:
    `SELECT path, status, count(*) ... WHERE service_id=? AND status>=400  GROUP BY path, status ORDER BY 3 DESC LIMIT 5`.
    This is the "common error at some URL" answer.

`ServiceDetail.vue` shows two numbers ("Total page views" / "Past week",
labelled approximate) and, when there are errors, a small "Top errors (7d)"
list. No charts.

Detecting **dead** and **spiking** sites is a follow-up that reads `daily` (e.g.
compare this week vs. the 4-week median); the schema already supports it, but no
alerting is built now.

## Extensibility

`event` is intentionally generic (`host`, `path`, `status`, `method`). Logging
other things later — deploy events, custom app events — fits as additional event
sources writing into the same pipeline (possibly an `event_type` column),
without reworking storage. Out of scope now; page views only.

## Alternatives considered

- **Store it in the main `sitey.db`.** Rejected: couples disposable high-write
  data to precious config, invites write contention and lock waits, and makes
  "wipe analytics" risky.
- **No detailed tier — only counters.** Loses the ability to answer "which URL
  is 500ing", which is one of the three stated goals. The 7-day `event` window
  is the minimum that satisfies it while staying bounded.
- **Keep raw events forever / longer.** Unbounded disk for a 1M/month site.
  Rollups give us the long-term signal at a fraction of the size.
- **Read Caddy logs via the Docker API** (`container.logs`, we already mount the
  socket) instead of a file. Rejected: Caddy's stdout mixes operational logs
  with access logs, parsing/filtering is fiddlier, and there's no rolling/offset
  story as clean as a dedicated rolled file.
- **A real time-series DB** (Prometheus, ClickHouse, VictoriaMetrics). Rejected:
  sitey is a single-host, low-dependency PaaS; a separate SQLite file with four
  small tables meets every stated goal without a new service to run, back up,
  and secure.

## Files (implementation sketch)

- `server/src/services/caddy.ts` — emit `log { output file … }` + per-route
  `log_append service_id <id>` in user site blocks.
- `server/src/lib/analyticsDb.ts` — `better-sqlite3` connection, WAL, schema
  bootstrap, prepared statements.
- `server/src/services/analytics/ingest.ts` — tail + parse + batched upsert
  worker.
- `server/src/services/analytics/prune.ts` — daily retention job.
- `server/src/routers/analytics.ts` — `forService` query.
- `web/src/pages/ServiceDetail.vue` — two numbers + optional top-errors list.
- `deploy/docker-compose.yml` — `caddy-logs` volume (rw on caddy, ro on
  sitey-api).

```

```
