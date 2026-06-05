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
"what is safe to delete?" are obvious. Both SQLite files sit directly at the
data root — there is no `db/` subdirectory (it wasn't worth a migration to add
one):

```
/data/
  sitey.db            # config DB — PRECIOUS, the primary backup target
  sitey.db-wal        #   write-ahead log: committed writes not yet folded into sitey.db
  sitey.db-shm        #   shared-memory index for the WAL (transient, recreated on open)
  analytics.db        # analytics history — secondary, but NOT rebuildable (back up too)
  analytics.db-wal    #   write-ahead log for analytics.db
  analytics.db-shm    #   shared-memory index for the WAL (transient, recreated on open)
  services/           # per-service repos & runtime volumes
  web/                # built SPA        (rebuildable — re-run sitey-web-builder)
  caddy-logs/         # Caddy access log (transient, self-rolling)
    access.log
```

- **The two `.db` files are the backup target.** Copy `sitey.db` and
  `analytics.db` — ideally with the API stopped, or via SQLite's online backup —
  and you have the whole system's config plus the analytics history. Include the
  `-wal`/`-shm` sidecars if copying a live, running DB (the `-wal` can hold
  committed-but-not-yet-checkpointed writes); they're irrelevant once the DB is
  cleanly stopped. `analytics.db` belongs in the backup precisely because it
  can't be rebuilt once raw logs roll away.
- **`services/`** holds user code and data; large but reconstructable from Git +
  redeploy, except for any app-written runtime data.
- **`web/`** and **`caddy-logs/`** are derived/transient and can be regenerated.

### Which containers see what

- **sitey-api** mounts the whole `/data` (rw): owns both databases, reads
  `caddy-logs/` to ingest analytics.
- **caddy** mounts `web/` and `services/` read-only (to serve them) and
  `caddy-logs/` read-write (to write the access log). It does **not** touch the
  databases.

## Files

- `server/prisma/schema.prisma` — config DB schema (Prisma).
- `server/src/lib/db.ts` — config DB client (`better-sqlite3` adapter).
- `server/src/lib/analyticsDb.ts` — analytics DB connection
  (`/data/analytics.db`)
  - schema bootstrap.
- `deploy/docker-compose.yml` — `DATABASE_URL` (`file:/data/sitey.db`),
  data-root and `caddy-logs` mounts.
