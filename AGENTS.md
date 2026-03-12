# Agent instructions

Read `docs/development.md` before editing code. The rules there are mandatory —
especially:

- **UI linearity:** every form field and nav item gets its own full-width row,
  top to bottom. No side-by-side inputs, no horizontal nav bars on mobile.
- **Avoid repeating yourself:** reusable classes live in
  `web/src/styles/components.css`. Do not redefine them inside scoped component
  styles. Don't create the same modal in two different pages, use a component
  instead, etc.
