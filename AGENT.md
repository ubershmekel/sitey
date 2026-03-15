# Sitey – CLAUDE.md

## Dev commands

- Prefer `npm run` over `npx` when an npm script exists.
  - Apply migrations (prod): `npm run db:migrate -w server` (or root
    `npm run db:migrate`)
  - Create migration (dev): `npm run db:migrate:dev -w server`
  - Push schema (dev): `npm run db:push -w server`
  - Generate client: `npm run db:generate -w server`
  - Reset DB: `npm run db:reset -w server`
  - Studio: `npm run db:studio -w server`
  - Note: Prisma CLI needs `DATABASE_URL` env var — the `dev` script loads it
    via `--env-file .env` but Prisma scripts don't. Set it inline if needed.
- `npm run dev` — starts web :3000 + API :3001
- `npm install` — installs all workspaces
