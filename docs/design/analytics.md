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

In **every** generated site block (user blocks and the management block alike —
see Mapping for why we don't special-case the panel), emit:

```caddyfile
    log {
        output file /var/log/caddy/access.log {
            roll_size 20mb
            roll_keep 3
            roll_keep_for 168h
        }
        format filter {
            wrap json
            fields {
                request>remote_ip   delete
                request>remote_port delete
                request>client_ip   delete
                request>headers     delete
                request>uri         query {
                    delete *
                }
            }
        }
    }
```

**Privacy is enforced at write time, not just at ingest.** Caddy's default
`format json` is _not_ anonymous: it records `request.remote_ip` /
`request.client_ip`, the request headers (including `User-Agent`), and the full
`request.uri` _with_ the query string. Dropping those fields only in sitey-api
would still leave them sitting in the raw `${DATA_ROOT}/caddy-logs/access.log`
for the whole roll window (up to ~168h / 60MB). So we use a `format filter`
(`wrap json`) that **deletes** the IP, port, and header fields and strips every
query parameter from `request>uri` _before_ the line is ever written to disk.
The raw file therefore never contains an IP, a user-agent, a cookie, or a query
string — which is what lets the privacy claim below hold. (Caddy already redacts
`Cookie`/`Authorization` by default, but we delete the whole `headers` object
rather than rely on that.)

A single shared `access.log` (rather than one file per site) keeps the tailer
simple — one file, one offset. `roll_size`/`roll_keep` bound the raw file to
~60MB regardless of traffic; once ingested we don't need the raw lines.

Since this `log` block is identical in every site block, the generator can
define it once as a Caddyfile snippet — `(requests_log) { log { … } }` at the
top — and emit a single `import requests_log` per block instead of repeating it.
That keeps the generated config short and the privacy filter in one auditable
place; the per-route `log_append service_id` stays inline (it varies per route
and a block may carry several, so it isn't part of the shared snippet).

> Caddy log-filtering reference:
> [log directive](https://caddyserver.com/docs/caddyfile/directives/log) ·
> [log_append](https://caddyserver.com/docs/caddyfile/directives/log_append).

### Mapping a request → service

A log line gives us `host` and `uri`; we need a `serviceId`. Two options:

**Primary — `log_append` (Caddy ≥ 2.9, which `caddy:alpine` already is).**
Inside each route's `handle`/`handle_path` block (where `appendRouteHandler`
already writes the handler), append a constant field:

```caddyfile
        log_append service_id 42
```

`Service.id` is an `Int` (`@default(autoincrement())`), so the appended value is
a bare number and lands in the JSON line as a number — ingestion reads
`service_id` straight off it, no re-matching, correct even for path-prefix
routes that fan multiple services onto one host. This is the recommended
approach.

**Fallback — host/path resolution at ingest.** If we ever can't tag, sitey-api
keeps an in-memory routing table (host + path-prefix → serviceId), rebuilt on
every Caddy reload (we already rebuild routing state there), and matches each
line. More code, duplicates Caddy's matching semantics (wildcards, longest
prefix); only worth it if `log_append` becomes unavailable.

**The sitey admin panel is just another service: reserved `service_id 0`.** A
`log` directive in Caddy is per-site-block, not per-route — and the generator
already folds wildcard path-prefix _user_ routes into the management host blocks
(`mgmtRoutes` → [caddy.ts](../../server/src/services/caddy.ts#L578), emitted
into the `:80` and named-domain blocks at
[caddy.ts](../../server/src/services/caddy.ts#L593)). Rather than special-case
the panel out of the log (via `log_skip`, conditional `log` blocks, or a
nullable `service_id` that the ingest path then has to branch on), we give the
panel a real, reserved id and treat it uniformly:

- Every block — including the management block — gets the same `log` directive.
- Each user route gets `log_append service_id <id>`; the **admin handlers get
  `log_append service_id 0`** (`appendAdminHandlers`). Real services
  autoincrement from 1, so **0 can never collide with a user service** — it's a
  synthetic id meaning "the sitey control panel," with no `Service` row behind
  it.
- So **every** access-log line carries a numeric `service_id`. There is no NULL
  case, no branch in the ingest hot path, and no generator code to suppress the
  panel — it rolls up into `daily`/`weekly`/`total` exactly like any service.
- The UI knows `0` = "Admin panel" and labels or filters it as a display choice.
  It never appears in the per-service list (which comes from the config DB's
  `Service` rows, all ≥ 1); it only surfaces on the analytics page under its
  reserved label.

This keeps one uniform code path: tag every route, roll up every line, and let
the _display_ layer decide whether to show or hide id 0.

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

**Privacy:** we deliberately log **no IP, no user-agent, no cookies, and no
query string** — only host, path, status, method, content-type, and response
size. This is enforced by the `format filter` block above, which deletes those
fields _before_ Caddy writes the line, so even the raw on-disk `access.log` is
free of them (not just `analytics.db`). There is no per-visitor data, so this
needs no cookie banner and stores no personal data (and, by the same token, no
unique-visitor counts — out of scope).

## 2. Ingestion

A single background worker in sitey-api, started in `main()` alongside the
initial Caddy reload.

- **Tail.** Open `access.log`, seek to the saved byte offset (from `meta`), read
  new lines as they arrive. Persist the offset **and the file identity** (see
  below) after each successful batch.
- **Rotation.** Track the open file by **identity (`dev` + `ino` from `fstat`,
  device id and inode), not by size.** A size comparison alone is unsafe: on a
  busy site Caddy can roll the file and the _new_ `access.log` can grow past the
  old saved offset before the poller wakes, so a "is the file now smaller?"
  check would miss the roll and blindly seek into the middle of the fresh file —
  silently skipping every line before that offset. Instead, on each poll:
  1. Keep reading the **currently open handle** to EOF first (drain the tail of
     the file we were already on, even after it's been renamed by the roll).
  2. `stat` the _path_ `access.log`; if its `dev`/`ino` differs from the open
     handle's, Caddy rolled it — open the new path, reset offset to 0, and read
     it from the start.
  3. Persist `{ino, dev, offset}` together in `meta`, and on startup only reuse
     the saved offset if the on-disk `ino`/`dev` still match (otherwise start at
     0). (We still accept that lines written to the old file after our last read
     but before the rename are lost — best effort.)
- **Parse.** JSON per line; pull `ts`, `request.host`, `request.uri`, `status`,
  `request.method`, `service_id`, the response `Content-Type` (normalized to the
  bare MIME type, params dropped), and the response `size` (bytes).
- **Normalize the path.** Strip the query string, lowercase the host, and
  **truncate the path** to ~128 chars. This caps `request` row size and path
  cardinality (the long tail of `?cache-bust=…` URLs collapses).
- **Batch.** Buffer in memory; flush every ~2s or every ~500 lines, whichever
  first, inside **one transaction**: insert into `request` and upsert the
  `daily`, `weekly`, and `total` counters in the same txn. Counters are
  maintained incrementally so pruning `request` later never disturbs them. Every
  line has a `service_id` (admin panel = 0; see Mapping), so the upsert is
  unconditional — no NULL branch, and id 0 rolls up like any other service.
- **Isolation.** All of this runs on the analytics DB connection only — a single
  `better-sqlite3` connection shared with the prune job and the read queries, so
  writes are serialized and never collide (WAL still lets the UI read
  concurrently). Any error logs and drops the batch — it must never throw into
  request handling or touch the config DB.

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

`analytics.db` lives at `/data/analytics.db`, next to the config DB
(`/data/sitey.db`). The access log is written by Caddy to
`/var/log/caddy/access.log` inside the containers, which is the host's
`$DATA_ROOT/caddy-logs/access.log` (bind-mounted: read-write on caddy, read-only
on sitey-api). The overall on-disk layout and durability tiers are described in
[data-model.md](data-model.md) — not repeated here. The container access-log
path is configurable via `CADDY_ACCESS_LOG` (default
`/var/log/caddy/access.log`).

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
  service_id   INTEGER NOT NULL,       -- 0 = sitey admin panel; >=1 = a user service
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
-- `week` is the ISO-8601 week number as (ISO-year * 100 + ISO-week); note the
-- ISO week-numbering year can differ from the calendar year at Dec/Jan
-- boundaries, so compute it from the date library's ISO helpers, not by hand.
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
enough to keep for 90 days. The detailed `request` tier exists only so the
analytics page can answer "which URL is erroring" (any status — 404s and 5xx),
"what's most requested" for the last week — and, later, "show me all the
images/JSON/etc."

`weekly` has **no reader yet** — it's the long-term granular tier, written now
(it's tiny and free to keep forever) so a future "traffic over the last year"
view has per-week history once `daily` has aged out past 90 days. This is the
same store-now/use-later stance as `content_type` (see
[Extensibility](#extensibility)); the dead/spiking follow-up at the end of
[§4](#4-surfacing-it) reads `daily`, not `weekly`. Every tier keys on a
`service_id` that is always present (admin panel = 0; see Mapping), so there is
no NULL row to reason about — the panel is just service 0 across all four
tables.

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

### Disk budget

The expected instance is small. Sizing by realistic load:

- **Typical (~100 req/day):** ~700 `request` rows for the 7-day window —
  kilobytes. Analytics-page `GROUP BY`s are instant.
- **Busy (~30K req/day):** ~210K rows for the window at ~150 bytes/row ≈
  **~30MB**. Direct `GROUP BY` over the `(service_id, ts)` index is still
  milliseconds; no rollups needed.
- **Pathological (~1M req/day):** ~7M rows ≈ **~1GB**. This is the only case the
  7-day `request` tier gets large; the lever is shrinking its retention toward
  ~2–3 days (§ Retention). Even here the queries stay indexed and the headline
  counters come from `daily`, so the page doesn't fall over.
- Rolled raw `access.log` ≈ **up to ~60MB** (capped by `roll_size`×`roll_keep`).
- `daily`: 90 rows. `weekly`: ~52/year. `total`: 1 row. → **kilobytes**.

Only the `request` tier scales with traffic, and it's the part we aggressively
prune. The rollups (`daily`/`weekly`/`total`) that power the headline numbers
stay tiny regardless.

## 4. Surfacing it

The detailed views live on their **own analytics page**, not embedded in the hot
`ServiceDetail.vue`. This is the key simplification: because the breakdowns (top
paths, top error/404 URLs, bandwidth) are only computed when a user navigates to
analytics — not on every service-detail open — we can query the `request` table
**directly** and skip rollup tables and caches entirely.

That's the right call for the expected load. A typical instance serves ~100
requests/day; even a busy one at ~30K/day is ~210K `request` rows over the 7-day
window, which a `GROUP BY` over the `(service_id, ts)` index handles in
milliseconds on a page that's opened occasionally. We deliberately do **not**
pre-aggregate paths/errors into rollup tables or build a multi-layer cache —
that machinery would be solving a problem this workload doesn't have, and it
bakes in choices (e.g. "errors = 5xx only") that block ad-hoc questions like
"what are my top 404s?".

A new tRPC router `analytics` (read-only, `settledProcedure`) reading
`analytics.db`:

- `analytics.forService({ serviceId })` — the **headline counters**, cheap
  enough that `ServiceDetail.vue` _can_ show them inline if we want:
  `{ totalRequests, last7dRequests, last7dErrors, last7dBytes }`
  - `totalRequests` ← `total.requests`.
  - `last7dRequests`/`last7dErrors`/`last7dBytes` ← sum over `daily` for the
    last 7 days (O(rollup), survives `request` pruning). `last7dBytes` is
    bandwidth.
  - A service with no traffic yet has no `total`/`daily` rows; the query returns
    **all zeros** (not null/error), so the UI always has numbers to show.

- `analytics.detail({ serviceId, days = 7, status? })` — the **analytics page**
  data, queried straight off `request`:
  - `topPaths` (most-requested URLs):
    `SELECT path, count(*) c FROM request WHERE service_id=? AND ts>=? GROUP BY path ORDER BY c DESC LIMIT 20`.
  - `topErrors` — **any status the user asks for**, not just 5xx. Default to
    `status >= 400` so 404s show up; the optional `status` filter narrows it
    (e.g. exactly `404`, or `>= 500`):
    `SELECT path, status, count(*) c FROM request WHERE service_id=? AND status>=400 AND ts>=? GROUP BY path, status ORDER BY c DESC LIMIT 20`.
  - Admin-panel traffic is just `service_id = 0` (see Mapping). The same
    `forService`/`detail` queries work on it unchanged; the analytics page shows
    it in a separate "Admin panel" view or hides it — a display toggle. Because
    its id is 0 and real services are ≥ 1, it is never folded into a user
    service's numbers.

`ServiceDetail.vue` keeps only the cheap headline numbers (**Requests** total /
past week, **Bandwidth (7d)**, labelled approximate) and links to the analytics
page. The analytics page (`web/src/pages/Analytics.vue`) shows **Top paths** and
**Top status codes / errors** (with the 404-vs-5xx toggle) for the selected
service. No charts.

**Reserved id 0 = the sitey admin panel.** There is no `Service` row for it, so
the UI can't look up a name from the config DB — it hardcodes the label "Admin
panel" for `service_id === 0`. Use a single shared constant (e.g.
`ADMIN_SERVICE_ID = 0`) on both server and web rather than a magic literal. The
panel is offered as its own selectable entry alongside the real services (or
hidden via a toggle); since real ids are all ≥ 1, it never appears inside a user
service's numbers.

If `request` ever does get heavy on an unusually busy instance, the lever is the
same one already in the design — shrink `request` retention from 7 days toward
~2–3 (§ Retention); the headline counters come from `daily` and are unaffected.

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

- `server/src/services/caddy.ts` — emit the **same** per-site
  `log { output file … }` (using `format filter` to delete IP/headers/query) on
  every block, management included; add per-route `log_append service_id <id>`
  for user routes and `log_append service_id 0` in `appendAdminHandlers` for the
  panel. Every line ends up tagged — no `log_skip`/conditional-log
  special-casing and no nullable `service_id`.
- `server/src/lib/analyticsDb.ts` — `better-sqlite3` connection at
  `/data/analytics.db`, WAL, schema bootstrap, prepared statements.
- `server/src/services/analytics/ingest.ts` — tail (track `dev`/`ino`, drain
  before switching on roll) + parse + batched upsert worker (normalizes
  `content_type`, sums `bytes`, upserts `daily`/`weekly`/`total` in one txn).
- `server/src/services/analytics/prune.ts` — daily retention job (`request` 7d,
  `daily` 90d).
- `server/src/routers/analytics.ts` — `forService` (cheap headline counters from
  `daily`/`total`) and `detail` (topPaths / topErrors queried directly off
  `request`, with the status filter).
- `web/src/pages/Analytics.vue` — top paths + top status codes/errors
  (404-vs-5xx toggle) for the selected service; `ServiceDetail.vue` shows only
  the headline numbers and links here. Renders `service_id === ADMIN_SERVICE_ID`
  (0) as "Admin panel" since it has no `Service` row to name it.
- Shared `ADMIN_SERVICE_ID = 0` constant (server + web) — the reserved id for
  the control panel; used by `caddy.ts` (the `log_append` value), the
  ingest/query code, and the web label. Avoids a magic `0` scattered across
  layers.
- `deploy/docker-compose.yml` — `${DATA_ROOT}/caddy-logs` bind mount (rw on
  caddy, ro on sitey-api). Both DBs sit at the data root (`/data/sitey.db`,
  `/data/analytics.db`); see [data-model.md](data-model.md).
