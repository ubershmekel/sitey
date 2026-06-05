# Data model & on-disk layout

Where Sitey keeps its state, and how durable each piece is. This is the general
storage map; feature-specific schemas live with their feature (e.g.
[analytics.md](analytics.md)).

## Two databases

Sitey uses **two separate SQLite files**, split by durability and access
pattern:

| DB             | Holds                            | Driver                    | Durability                                                 |
| -------------- | -------------------------------- | ------------------------- | ---------------------------------------------------------- |
| `sitey.db`     | All config (the source of truth) | Prisma (`schema.prisma`)  | **Precious** — back this up                                |
| `analytics.db` | Request traffic counters         | raw `better-sqlite3`, WAL | **Secondary** — losing it costs history, not config/uptime |

`sitey.db` is read-mostly and transactional — users, domains, services, routes,
deployments. `analytics.db` is write-heavy and secondary — its loss never breaks
Sitey or touches config, but it is **not** rebuildable: all-time totals and past
rollups are accumulated incrementally and the raw access log only lasts ~7 days,
so deleting it permanently loses traffic history. Isolating it keeps analytics'
write volume off the config DB and lets it run with looser durability
(`synchronous = NORMAL`). See [analytics.md](analytics.md) for its schema and
rationale.

## Directory layout

The data root (`$DATA_ROOT` on the host, `/data` inside containers,
bind-mounted) is organized by **durability tier**, so "what do I back up?" and
"what is safe to delete?" are obvious:

```
/data/
  db/                 # databases — THE backup target
    sitey.db          #   config            (precious)
    sitey.db-wal/-shm
    analytics.db      #   analytics history (secondary, NOT rebuildable)
    analytics.db-wal/-shm
  services/           # per-service repos & runtime volumes
  web/                # built SPA            (rebuildable — re-run sitey-web-builder)
  caddy-logs/         # Caddy access log     (transient, self-rolling)
    access.log
```

- **`db/`** is the only directory a backup needs. Copy it (ideally with the DB
  stopped or via SQLite online backup) and you have the whole system's config —
  plus the analytics history, which lives here precisely because it can't be
  rebuilt.
- **`services/`** holds user code and data; large but reconstructable from Git +
  redeploy, except for any app-written runtime data.
- **`web/`** and **`caddy-logs/`** are derived/transient and can be regenerated.

### Which containers see what

- **sitey-api** mounts the whole `/data` (rw): owns both databases, reads
  `caddy-logs/` to ingest analytics.
- **caddy** mounts `web/` and `services/` read-only (to serve them) and
  `caddy-logs/` read-write (to write the access log). It does **not** touch the
  databases.

## Migration: flattening `/data` into `/data/db/`

Historically `sitey.db` lived at the data-root (`/data/sitey.db`). New installs
should use `/data/db/sitey.db`; existing installs are migrated automatically:

- A one-time startup step (before Prisma connects) moves `/data/sitey.db` →
  `/data/db/sitey.db`, including its `-wal`/`-shm` sidecars, if the old path
  exists and the new one doesn't.
- `DATABASE_URL` becomes `file:/data/db/sitey.db` in `docker-compose.yml` and
  the dev `.env`.

`analytics.db` is new, so it is created at `/data/db/analytics.db` directly.

## Files

- `server/prisma/schema.prisma` — config DB schema (Prisma).
- `server/src/lib/db.ts` — config DB client (`better-sqlite3` adapter).
- `server/src/lib/analyticsDb.ts` — analytics DB connection + schema bootstrap.
- `server/src/index.ts` (or `bootstrap.ts`) — the `/data/db/` move-on-startup.
- `deploy/docker-compose.yml` — `DATABASE_URL`, data-root and `caddy-logs`
  mounts.
