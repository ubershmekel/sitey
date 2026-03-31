# Future Features

Features still in consideration or design phase.

## SPA Fallback for Static Sites

Currently all static sites get `try_files {path} /index.html` unconditionally. Treating them like an single-page-app (SPA).

We should add a `fallbackPath` string field on the Service model (default `"index.html"`) to make this configurable:

- `"index.html"` (default) -- SPA mode, all unmatched routes serve the app shell.
- `"404.html"` -- serve a custom 404 page for missing paths.
- `""` (empty) -- plain static hosting, Caddy returns its default 404.

This covers SPAs, multi-page static sites, and custom 404 pages with a single field. No need to parse convention files (`_redirects`, `vercel.json`, etc.) or build a redirect engine -- users who need complex routing can use server mode instead.

Another option is to have a `strictServing` boolean that will make Caddy 404 on unmatched paths.

Another option is to build some redirect engine, though we kind of already have that with Routes per Service.
