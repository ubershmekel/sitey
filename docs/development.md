# Development Guide

## Local setup

```bash
# Install dependencies
cd server && npm install
cd ../web  && npm install

# Start the API (terminal 1)
cd server
npm run db:push   # apply schema directly to dev DB (skips migration history)
npm run dev       # starts on :3001

# Start the web (terminal 2)
cd web
npm run dev       # starts on :5173 (proxies /trpc and /webhook → :3001)
```

## DB scripts (`server/package.json`)

| Script        | Command                 | Use                                                                   |
| ------------- | ----------------------- | --------------------------------------------------------------------- |
| `db:push`     | `prisma db push`        | Dev only — apply schema directly, no migration file created           |
| `db:migrate`  | `prisma migrate deploy` | Production — apply pending migrations (runs automatically on startup) |
| `db:generate` | `prisma generate`       | Regenerate the Prisma client after schema changes                     |
| `db:studio`   | `prisma studio`         | Open a browser-based DB editor                                        |

## Keeping migrations in sync with schema.prisma

The file `server/prisma/migrations/0001_init/migration.sql` is what actually
runs in production when the container starts. If `schema.prisma` changes but the
migration SQL does not, the API will crash on boot with a `P2022`
column-not-found error.

### Rules

- **In dev**, use `npm run db:push` freely — it syncs the local SQLite file
  directly without touching migrations.
- **Before committing schema changes**, update the migration SQL so production
  stays in sync.

### When you change `schema.prisma`

**Option A — additive change (new column with a default, new table):** Create a
new migration file:

```bash
cd server
mkdir -p prisma/migrations/0002_<description>
npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/0002_<description>/migration.sql
```

Then commit both `schema.prisma` and the new migration file.

**Option B — breaking change (column removed, renamed, type changed):** Since
this project is pre-1.0 and easy to wipe, just rewrite the baseline migration:

```bash
cd server
npx prisma migrate diff \
  --from-empty \
  --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/0001_init/migration.sql
```

Then commit. Anyone running an existing instance will need to wipe their DB (see
[DANGER: Wipe the data](../README.md#danger-wipe-the-data-fresh-start) in the
README).

### Verify before pushing

```bash
cd server
npx prisma validate        # checks schema.prisma is valid
npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --exit-code              # exits non-zero if migrations are out of sync
```

If the last command exits non-zero, the migration SQL needs updating.

## Architecture notes

- **Single-host only.** The deployment queue is in-memory; multi-instance
  requires Redis.
- **Docker socket.** `sitey-api` has full access to the Docker daemon — treat it
  as root-equivalent.
- **Secrets.** JWT secret is auto-generated on first boot and stored in the DB.
  Passwords are argon2id-hashed. GitHub App private key is stored as-is in
  SQLite — encrypt at rest if your threat model requires it.

## Running with hot-reload (no Docker rebuilds)

The root `package.json` has a `dev` script that starts both in parallel:

```bash
# From repo root — installs deps if needed, then starts both
npm install
npm run dev
```

- **API** → `http://localhost:3001` (`tsx watch` auto-restarts on file save)
- **Web** → `http://localhost:5173` (Vite HMR, proxies `/trpc`, `/webhook`, `/health` to `:3001`)

No Docker needed for everyday UI/API work. On first boot the generated admin
password is printed to the terminal.

### With Caddy for HTTPS testing

When you need TLS or domain routing, run only Caddy in Docker and keep
everything else native.

#### Option 1 — SSH tunnel from a VPS (recommended for real DNS + Let's Encrypt)

If your DNS points to a VPS, you can forward ports 80 and 443 from the VPS to
your local machine. Caddy runs locally, gets real Let's Encrypt certs, and
traffic flows through the tunnel.

**On the VPS**, enable `GatewayPorts` so the tunnel binds to all interfaces
(not just loopback):

```bash
# /etc/ssh/sshd_config
GatewayPorts yes
```
```bash
systemctl restart sshd
```

**On your local machine**, open the tunnel:

```bash
ssh -N -o ExitOnForwardFailure=yes \
  -R 0.0.0.0:80:localhost:80 \
  -R 0.0.0.0:443:localhost:443 \
  root@<YOUR_VPS_IP>
```

Now traffic hitting `<YOUR_VPS_IP>:80/443` is forwarded to Caddy running
locally. DNS still points to the VPS, Let's Encrypt HTTP-01 challenges work
normally, and you can iterate on code with `npm run dev` without touching the
VPS at all.

Add `-vvv` to the ssh command to debug tunnel issues.

#### Option 2 — Caddy in Docker, everything else native

**One-time setup:** add to `server/.env`:
```
CADDY_ADMIN_URL=http://localhost:2019
```

**Start only Caddy (dev mode):**
```bash
cd deploy

# Tear down the full stack first (or just stop api/web containers)
docker compose down

# Start Caddy with the dev Caddyfile (proxies to host machine instead of containers)
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d caddy
```

The dev Caddyfile (`deploy/caddy/Caddyfile.dev`) proxies to
`host.docker.internal:3001` (API) and `host.docker.internal:5173` (Vite). Port
2019 is exposed to the host so the native server can push Caddy config updates
(domains, HTTPS routes) exactly like production.

Then run `npm run dev` from the repo root as usual.

**Switch back to full production stack:**
```bash
cd deploy
docker compose down
docker compose up -d --build
```

**Targeted rebuild (faster than full rebuild):**
```bash
cd deploy
docker compose up -d --build sitey-api   # only rebuild the API
docker compose up -d --build sitey-web   # only rebuild the web
```

## See logs

```bash
# Production containers
docker compose -f deploy/docker-compose.yml logs sitey-api -f
docker compose -f deploy/docker-compose.yml logs caddy -f

# View live Caddy config (JSON)
curl http://localhost:2019/config/ | jq .
```
