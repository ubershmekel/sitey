# Security

## Cross-subdomain CSRF / CORS

### Threat

Sitey places its management UI at `sitey.<base>` and user-hosted apps on sibling
subdomains (`app.example.com`, `evil.example.com`, …) under the same wildcard
domain.

The session cookie is `SameSite=Lax`. Lax is scoped to the domain + scheme, not
the full origin. A request from `evil.example.com` to `sitey.example.com` is
cross-**origin** (different subdomain) but same-**site** (same eTLD+1 under
HTTPS), so the browser attaches the `sitey_session` cookie automatically.

If the server reflected any `Origin` back with
`Access-Control-Allow-Credentials: true`, a malicious or compromised hosted app
could execute credentialed `fetch()` calls against every tRPC endpoint —
`auth.resetUserPassword`, `github.setAppConfig`, `system.listContainers`,
deployment triggers, etc. — and read the full responses.

### Mitigation (two layers)

#### Layer 1 — CORS origin allowlist (`server/src/index.ts`)

The `@fastify/cors` plugin uses an explicit allowlist (no `origin: true`). Once
a management domain is configured, only that exact origin is allowed.

Browsers on a disallowed origin receive no `Access-Control-Allow-Origin` header
and cannot read responses even if the cookie was sent.

#### Layer 2 — Origin enforcement (onRequest hook) (`server/src/index.ts`)

A Fastify `onRequest` hook rejects any request whose `Origin` header is missing
or not in the allowlist.

This is defense in depth: even if CORS is bypassed (e.g. non-browser clients),
requests are blocked before reaching application logic.

Webhook paths (`/api/webhook/`, `/api/hook/`) are excluded, as they authenticate
via HMAC-SHA256 signatures rather than cookies or Origin.

#### CSRF posture

We do not use CSRF tokens and instead rely on Origin validation.

- All state-changing endpoints MUST use POST (never GET)
- All non-GET requests MUST include a valid Origin header
- Requests with missing or invalid Origin MUST be rejected

Rationale: Origin is not reliably present on GET/navigation requests, so
allowing mutations via GET would introduce CSRF risk.

### Non-mitigations considered

| Approach                       | Why not sufficient on its own                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------ |
| `SameSite=Strict`              | Would break OAuth redirect flows and GitHub App callbacks                                        |
| CSRF token per-request         | Adds state; Origin check is simpler and equally strong for same-site threats                     |
| Separate domain for management | Ideal but a deployment/UX constraint; CORS + Origin check achieves the same isolation in-process |
