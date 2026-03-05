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

| Script | Command | Use |
|---|---|---|
| `db:push` | `prisma db push` | Dev only — apply schema directly, no migration file created |
| `db:migrate` | `prisma migrate deploy` | Production — apply pending migrations (runs automatically on startup) |
| `db:generate` | `prisma generate` | Regenerate the Prisma client after schema changes |
| `db:studio` | `prisma studio` | Open a browser-based DB editor |

## Keeping migrations in sync with schema.prisma

**This is critical.** The file `server/prisma/migrations/0001_init/migration.sql` is what actually runs in production when the container starts. If `schema.prisma` changes but the migration SQL does not, the API will crash on boot with a `P2022` column-not-found error.

### Rules

- **In dev**, use `npm run db:push` freely — it syncs the local SQLite file directly without touching migrations.
- **Before committing schema changes**, update the migration SQL so production stays in sync.

### When you change `schema.prisma`

**Option A — additive change (new column with a default, new table):**
Create a new migration file:

```bash
cd server
mkdir -p prisma/migrations/0002_<description>
npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/0002_<description>/migration.sql
```

Then commit both `schema.prisma` and the new migration file.

**Option B — breaking change (column removed, renamed, type changed):**
Since this project is pre-1.0 and easy to wipe, just rewrite the baseline migration:

```bash
cd server
npx prisma migrate diff \
  --from-empty \
  --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/0001_init/migration.sql
```

Then commit. Anyone running an existing instance will need to wipe their DB (see [DANGER: Wipe the data](../README.md#danger-wipe-the-data-fresh-start) in the README).

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

- **Single-host only.** The deployment queue is in-memory; multi-instance requires Redis.
- **Docker socket.** `sitey-api` has full access to the Docker daemon — treat it as root-equivalent.
- **Secrets.** JWT secret is auto-generated on first boot and stored in the DB. Passwords are argon2id-hashed. GitHub App private key is stored as-is in SQLite — encrypt at rest if your threat model requires it.
