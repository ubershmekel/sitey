# Analytics (request traffic)

Lightweight, best-effort traffic analytics per service. The goal is to answer
three questions on a service's detail page without charts or configuration:

- How many requests has this service served **all time**?
- How many in the **past week**?
- Is something wrong — a **dead** site (traffic → 0), a **spike**, or a **common
  error** at some URL/host?

The unit is the HTTP **request** (one access-log line). We deliberately do _not_
classify requests into "page views" vs. assets — we just store each request with
its content type and size so the UI can slice it later (all images, all JSON,
etc.). That filtering is future work; this design is only the machinery.

Non-goals (for now): real-time dashboards, charts, content-type filtering UI,
per-visitor sessions, unique visitors, geo, referrers, retention/funnels,
billing-grade accuracy, or any user-facing configuration. Sane defaults only.

## Principles

1. **Never slow down serving.** Static sites and proxied apps are served by
   Caddy directly — sitey-api is not on the request path. Analytics must stay
   off that path too: Caddy logs asynchronously, sitey-api ingests out-of-band.
2. **Bounded disk, forever.** Detailed data is short-lived; only small rollups
   live long. A high-traffic site must not grow the disk without bound.
3. **Best-effort, not exact.** We may lose a batch on crash or rotation. That's
   fine — these numbers drive intuition, not invoices. State this plainly in the
   UI ("approximate").
4. **Decoupled from config.** Analytics is secondary; the config DB is not.
   Wiping analytics loses traffic history but must never risk a domain, service,
   or cert. (Note: "secondary" ≠ "rebuildable" — the history can't be
   reconstructed once raw logs roll away, so `analytics.db` still belongs in
   backups.)

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
              parse + map host/path → serviceId       ├─ request   (7 days)
                                                       ├─ daily     (90 days)
                                                       ├─ weekly    (forever)
                                                       └─ total     (forever)
```

The user's request never touches sitey-api or analytics.db. Caddy appends a line
to a rolled log file; sitey-api tails that file and folds it into counters in a
separate SQLite database.

## 1. Getting request logs out of Caddy

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

### What we store per request

The unit is one HTTP request = one access-log line = one `request` row. We store
the raw facts and nothing fancier:

- `host`, `path`, `status`, `method` — what was asked and how it went.
- `content_type` — the response MIME type, params stripped (e.g. `text/html`,
  `application/json`, `image/png`). Stored so the UI can **later** slice traffic
  by type ("show me all images / all JSON / all binaries"). We do not build that
  filtering now, and we do not collapse requests into "page views" — that's a
  judgement we'd rather leave to query time.
- `bytes` — response size, for bandwidth.

The headline activity number is simply the **count of requests** (and bytes for
bandwidth). One real page load fires many requests (HTML + CSS + JS + images +
XHR), so this counts hits, not human page loads — that's fine for "is this site
alive / spiking / erroring", which is all we're after.

**Privacy:** we deliberately log **no IP, no user-agent, no cookies** — only
host, path, status, method, content-type, and response size. There is no
per-visitor data, so this needs no cookie banner and stores no personal data
(and, by the same token, no unique-visitor counts — out of scope).

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
  `request.method`, `service_id`, the response `Content-Type` (normalized to the
  bare MIME type, params dropped), and the response `size` (bytes).
- **Normalize the path.** Strip the query string, lowercase the host, and
  **truncate the path** to ~128 chars. This caps `request` row size and path
  cardinality (the long tail of `?cache-bust=…` URLs collapses).
- **Batch.** Buffer in memory; flush every ~2s or every ~500 lines, whichever
  first, inside **one transaction**: insert into `request` and upsert the
  `daily`, `weekly`, and `total` counters in the same txn. Counters are
  maintained incrementally so pruning `request` later never disturbs them.
- **Isolation.** All of this runs on the analytics DB connection only. Any error
  logs and drops the batch — it must never throw into request handling or touch
  the config DB.

Because static-site and proxy traffic is served entirely by Caddy, this worker
adds **zero latency** to page loads — it's pure background I/O.

## 3. Storage: a separate SQLite file

**Decision: a dedicated `analytics.db`, opened with `better-sqlite3` directly
(not Prisma), in WAL mode.**

Why separate from the main config DB:

- **Different durability.** Config is precious and must never be lost; analytics
  is secondary — deleting `analytics.db` is a safe recovery move that keeps
  Sitey running and config intact. It does cost traffic history (the counters
  aren't rebuildable), but that's a tolerable loss in a way config never is.
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

### Where the files live

`analytics.db` lives at `/data/db/analytics.db`, next to the config DB, and the
access log at `/data/caddy-logs/access.log`. The overall on-disk layout,
durability tiers, and the `/data/db/` migration are described in
[data-model.md](data-model.md) — not repeated here. The access log path is
configurable via `CADDY_ACCESS_LOG` (default `/var/log/caddy/access.log` inside
the containers).

`analytics.db` opens with WAL; the worker no-ops cleanly if the access log path
doesn't exist yet (fresh install, or dev without Caddy).

### Schema

```sql
-- Request log (detailed tier): one row per HTTP request, rolling ~7 days.
-- Holds ALL requests, with content_type + bytes, so the UI can slice by type
-- later and so errors/bandwidth are visible.
CREATE TABLE request (
  id           INTEGER PRIMARY KEY,
  ts           INTEGER NOT NULL,       -- unix seconds, UTC
  service_id   INTEGER,                -- NULL = unmatched / management
  host         TEXT    NOT NULL,
  path         TEXT    NOT NULL,       -- query stripped, truncated to ~128
  status       INTEGER NOT NULL,
  method       TEXT,
  content_type TEXT,                   -- bare MIME, params dropped (e.g. 'text/html')
  bytes        INTEGER NOT NULL DEFAULT 0  -- response size, for bandwidth
);
CREATE INDEX request_svc_ts ON request (service_id, ts);
CREATE INDEX request_ts      ON request (ts);

-- Daily rollup: ~90 days. Powers "past week" and spike/dead detection cheaply.
-- requests = all requests; errors = status >= 500 (server errors — 404 asset
-- noise excluded); bytes = total response bytes (bandwidth). Days in UTC.
CREATE TABLE daily (
  service_id INTEGER NOT NULL,
  day        INTEGER NOT NULL,        -- yyyymmdd, UTC
  requests   INTEGER NOT NULL DEFAULT 0,
  errors     INTEGER NOT NULL DEFAULT 0,
  bytes      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (service_id, day)
);

-- Weekly rollup: kept forever (tiny — ~52 rows/service/year).
CREATE TABLE weekly (
  service_id INTEGER NOT NULL,
  week       INTEGER NOT NULL,        -- ISO year-week, e.g. 202623
  requests   INTEGER NOT NULL DEFAULT 0,
  errors     INTEGER NOT NULL DEFAULT 0,
  bytes      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (service_id, week)
);

-- Lifetime tier: forever, one row per service.
CREATE TABLE total (
  service_id INTEGER PRIMARY KEY,
  requests   INTEGER NOT NULL DEFAULT 0,
  errors     INTEGER NOT NULL DEFAULT 0,
  bytes      INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);

-- Worker state + schema version.
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
```

This mirrors exactly the tiering described in the request: **a week of detailed
logs, then a per-service weekly number, plus an all-time sum.** `daily` is the
middle workhorse — granular enough to spot a spike or a site going dead, small
enough to keep for 90 days. The detailed `request` tier exists only so we can
answer "which URL is erroring", "what's most requested", and "what's the common
500" for the last week — and, later, "show me all the images/JSON/etc."

### Retention & pruning

One cheap maintenance job, run daily (and once at startup):

| Tier      | Retention | Pruning                                     |
| --------- | --------- | ------------------------------------------- |
| `request` | 7 days    | `DELETE FROM request WHERE ts < now - 7d`   |
| `daily`   | 90 days   | `DELETE FROM daily WHERE day < today - 90d` |
| `weekly`  | forever   | none (≈52 rows/service/year)                |
| `total`   | forever   | none (1 row/service)                        |

Run `PRAGMA incremental_vacuum` (DB opened with `auto_vacuum = INCREMENTAL`)
after the `request` delete so freed pages return to the OS and the file doesn't
creep upward.

### Disk budget (worst case: a high-traffic service)

- A busy service serving, say, ~1M requests/day → ~7M rows for the 7-day window.
  At ~150 bytes/row ≈ **~1GB** at the high end (a quiet site is a rounding
  error).
- Rolled raw `access.log` ≈ **up to ~60MB** (capped by `roll_size`×`roll_keep`).
- `daily`: 90 rows. `weekly`: ~52/year. `total`: 1 row. → **kilobytes**.

Sites scale linearly in the `request` tier only, which is the part we
aggressively prune. Because that tier logs every hit, it's the one to watch: if
it proves too heavy, the cheapest lever is shrinking its retention from 7 to
~2–3 days — the rollups, which power the headline numbers, are unaffected.

## 4. Surfacing it

A new tRPC router `analytics` (read-only, `settledProcedure`) reading
`analytics.db`:

- `analytics.forService({ serviceId })` →
  `{ totalRequests, last7dRequests, last7dErrors, last7dBytes, topPaths, topErrors }`
  - `totalRequests` ← `total.requests`.
  - `last7dRequests`/`last7dErrors`/`last7dBytes` ← sum over `daily` for the
    last 7 days (cheap, survives `request` pruning). `last7dBytes` is the
    bandwidth figure.
  - `topPaths` (most-requested URLs) ← from `request` for the last 7 days:
    `SELECT path, count(*) c FROM request WHERE service_id=? AND ts>=?  GROUP BY path ORDER BY c DESC LIMIT 5`.
    This is the "what's busiest" answer.
  - `topErrors` ← same window, server errors (any content type, so a failing
    `/api/…` or asset shows up):
    `SELECT path, status, count(*) c FROM request WHERE service_id=? AND status>=500 AND ts>=?  GROUP BY path, status ORDER BY c DESC LIMIT 5`.
    This is the "common error at some URL" answer.

`ServiceDetail.vue` shows the headline numbers — **Requests** (total / past
week), **Bandwidth (7d)** — labelled approximate, a small **"Top paths (7d)"**
list, and — only when there are errors — a **"Top errors (7d)"** list. No
charts.

Detecting **dead** and **spiking** sites is a follow-up that reads `daily` (e.g.
compare this week vs. the 4-week median); the schema already supports it, but no
alerting is built now.

## Extensibility

The `request` table captures the raw HTTP facts (`host`, `path`, `status`,
`method`, `content_type`, `bytes`). Storing `content_type` is what lets the UI
later slice traffic by type (all images / JSON / binaries) and, if we ever want
a "page views" number, derive it at query time (`content_type = 'text/html'`) —
without changing the schema. If instead we want to log a _different_ shape of
activity — deploy events, custom app events — that should get its own table
rather than being forced into `request`. Out of scope now; request counts only.

## Alternatives considered

- **Store it in the main `sitey.db`.** Rejected: couples secondary high-write
  data to precious config, invites write contention and lock waits, and makes
  "wipe analytics" risky.
- **No detailed tier — only counters.** Loses the ability to answer "which URL
  is 500ing" / "what's busiest", which is one of the stated goals. The 7-day
  `request` window is the minimum that satisfies it while staying bounded.
- **Classifying requests into "page views" vs. assets** (a stored `is_view`
  flag, or counting only `text/html`). Rejected for v0: it bakes a debatable
  judgement into the hot path and the schema. We store `content_type` instead
  and count raw requests; a page-view metric can be derived later at query time
  if wanted.
- **Keep the raw request log forever / longer.** Unbounded disk for a busy site.
  Rollups give us the long-term signal at a fraction of the size.
- **Read Caddy logs via the Docker API** (`container.logs`, we already mount the
  socket) instead of a file. Rejected: Caddy's stdout mixes operational logs
  with access logs, parsing/filtering is fiddlier, and there's no rolling/offset
  story as clean as a dedicated rolled file.
- **A real time-series DB** (Prometheus, ClickHouse, VictoriaMetrics). Rejected:
  sitey is a single-host, low-dependency PaaS; a separate SQLite file with four
  small tables meets every stated goal without a new service to run, back up,
  and secure.
- **Access log in a named Docker volume** instead of a data-root bind mount.
  Rejected for dev/prod parity: in dev, sitey-api runs on the host and can't
  read a Docker named volume, but it can read a bind-mounted file. A bind mount
  also stays directly inspectable for debugging.

## Files (implementation sketch)

- `server/src/services/caddy.ts` — emit per-site `log { output file … }` (with
  `Content-Type` + `size` captured) + per-route `log_append service_id <id>`.
- `server/src/lib/analyticsDb.ts` — `better-sqlite3` connection at
  `/data/db/analytics.db`, WAL, schema bootstrap, prepared statements.
- `server/src/services/analytics/ingest.ts` — tail + parse + batched upsert
  worker (normalizes `content_type`, sums `bytes`).
- `server/src/services/analytics/prune.ts` — daily retention job.
- `server/src/routers/analytics.ts` — `forService` (totals, last-7d, bandwidth,
  topPaths, topErrors).
- `web/src/pages/ServiceDetail.vue` — requests + bandwidth + "Top paths" +
  optional "Top errors".
- `deploy/docker-compose.yml` — `${DATA_ROOT}/caddy-logs` bind mount (rw on
  caddy, ro on sitey-api). The DB path move lives in
  [data-model.md](data-model.md).
