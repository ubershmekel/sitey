# Agent instructions

Read `docs/development.md` before editing code. The rules there are mandatory —
especially:

- **DB scripts:** prefer `npm run db:push` (dev) / `npm run db:migrate` (prod)
  over direct `prisma` calls. See the DB scripts table in `docs/development.md`.
- **npm scripts over npx:** use `npm run <script>` when an equivalent npm script
  exists.

- **UI linearity:** every form field and nav item gets its own full-width row,
  top to bottom. No side-by-side inputs, no horizontal nav bars on mobile.
- **Avoid repeating yourself:** reusable classes live in
  `web/src/styles/components.css`. Do not redefine them inside scoped component
  styles. Don't create the same modal in two different pages, use a component
  instead, etc.
- If you change .ts code then run `npm run test:types` to check for errors.
