# Config as code (YAML + remote CLI)

Sitey's configuration — domains, services, routes, DNS — can be pulled as a YAML
file, edited by a human or an agent, committed to git, and pushed back to a
Sitey server from any machine with a CLI. The UI keeps working; the file is a
second way in, not a replacement.

The motivating use case: an agent on my home machine sets up landing pages for
several ideas on a new VPS (`sitey.andluck.com`), including DNS on Namecheap,
without SSH access, without clicking through the UI, and with every change
reviewable in git.

## Goals

- **An agent can launch a landing page end to end**: page content, route, DNS
  record, TLS, deploy, and verification that it is live.
- **Config is reviewable and versioned.** Every change the agent makes is a diff
  in a git repo I control, and I can see what's live vs. what's committed.
- **No SSH for day-to-day work.** SSH is for install and recovery only.
- **Multiple VPSes from one machine.** `sitey --server andluck ...`,
  `sitey --server redditp ...`.
- **The one-line install and the web UI stay as they are.** Nobody should need
  GitHub or a config repo just to start using Sitey.
- **DNS is part of the config.** Adding a domain or a subdomain doesn't require
  opening the Namecheap dashboard.

## Non-goals (for now)

- **Team mode / GitOps** (Sitey pulling config from a repo on push). Designed
  for below so nothing here blocks it, but not built.
- **Managing the VPS itself** (cron, OS packages, backups, hardening). Sitey
  hosts sites; the VPS is where they run.
- **Buying domains.** A human does that.
- **Secrets in the file.** Env var _names_ only; values are set separately.
- **Multi-server orchestration** (moving a site between VPSes as one command).
  Each server has its own file; the CLI just knows about several servers.

## Background: why this exists

Sitey started as a UI for a human wiring GitHub repos, domains, and HTTPS
together on one VPS. All config lives in SQLite ("infra-as-db"). That was the
right call for a human with a dashboard, but it has costs:

- An agent has to drive a UI or poke at the DB.
- There's no history of what changed or who changed it.
- Copying a setup to a new VPS means clicking it all in again.
- A `sitey export` of a real instance showed the DB shape isn't how people think
  about sites: 16 domain rows where only 3 wildcards carried information,
  orphaned domains and repos nobody knew about, and the panel's hostnames not
  visible at all (they're derived from env vars and per-domain flags).

Alternatives considered:

| Option                                      | Why not                                                                                                                                                                      |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Let the agent SSH in and do whatever        | Works for the first site, rots after. No inventory, every session rediscovers state, hand-edited Caddy config breaks Sitey's invariants, and the agent gets root on the box. |
| A separate tiny landing-page deployer       | A worse copy of the parts of Sitey worth keeping (Caddy generation, TLS, analytics). Two systems doing one job.                                                              |
| Dokku-style `git push` to the server        | Needs host-level SSH users and hooks outside Docker; ties config to deploy mechanics.                                                                                        |
| Terraform provider                          | Terraform needs its own state file (another DB to back up), is push-only, needs a Go provider _plus_ the server, and is poor at "track a branch and redeploy".               |
| YAML file on the VPS, edited over SSH       | No history, needs SSH, lost with the VPS.                                                                                                                                    |
| Sitey pulls config from a git repo (GitOps) | Good for teams; for one person it's extra setup (a repo webhook per VPS) with little benefit over push/pull. Kept as **team mode**, below.                                   |

## Principles

1. **The DB stays the source of truth.** The server is authoritative; a YAML
   file is a snapshot. Pull, edit, push — like editing a remote document.
2. **One format, one parser, on the server.** The CLI is thin. Validation,
   diffing, and applying all happen server-side so every client (CLI, future UI
   import, future team mode) behaves the same.
3. **Dry-run first.** Every push shows the diff before anything changes.
4. **Never destroy data implicitly.** Removing a service from the file removes
   the service, but never its data directory or volumes, and never DNS records.
5. **Idempotent.** Pushing the same file twice is a no-op. `apply(export())`
   reports no changes.
6. **Explicit over derived.** If the file says it, it's true; nothing important
   is implied by a flag somewhere else.

## Modes

### Personal mode (build this)

```
 home machine                                   VPS (sitey.andluck.com)
 ─────────────                                  ───────────────────────
 myswe/ (private git repo)
 ├── landings/idea-a/        git push ──▶ GitHub ──clone (GitHub App)──▶ sitey-api
 ├── landings/idea-b/                                                      │
 └── sitey/andluck.yaml                                                    │
        │                                                                  │
   sitey CLI ── pull ◀──── HTTPS + bearer token ────▶ config.export        │
             ── push ─────────────────────────────▶ config.apply ─────────┤
                                                                           ├─▶ SQLite (truth)
                                                                           ├─▶ Caddy reload
                                                                           ├─▶ deploy queue
                                                                           └─▶ Namecheap API
```

- The YAML lives in whatever repo I like. For now: the private `myswe` repo, at
  `sitey/andluck.yaml`, next to the landing page folders it deploys.
- The CLI runs on my machine and talks to Sitey over HTTPS with an API token.
- The UI can still edit anything. The next `pull` shows those edits.

### Team mode (later, not built)

Same format and same `apply` code, different trigger:

- A config repo (e.g. `acme/sitey-config`) holds one file per server,
  `servers/<name>.yaml`.
- Each Sitey instance is pointed at its file once
  (`sitey config-source acme/sitey-config servers/prod.yaml`) and has the GitHub
  App installed on that repo.
- On push: pull, validate, apply. A bad file never half-applies; Sitey keeps the
  last good config and reports the error.
- Sitey posts a GitHub commit status (✓ applied / ✗ error) so whoever pushed
  sees the result with `gh`.
- File-managed config becomes read-only in the UI, with a link to the file.
- `config.apply` with `dryRun` stays useful for CI checks on pull requests.

Nothing in personal mode should assume the file is only ever pushed by a CLI.

## The file format

YAML 1.2 (the `yaml` npm package's default, which avoids the YAML 1.1 traps like
`no` → `false`). Validated by a zod schema shared by export and apply. Unknown
keys are errors, so agent typos fail loudly.

```yaml
version: 1

# The hostname the Sitey panel is served on.
panel: sitey.andluck.com

domains:
  andluck.com:
    dns: namecheap # Sitey writes DNS records via the Namecheap API
    wildcard: false # default: one A record per host used in routes
  redditp.com:
    dns: manual # you manage DNS; Sitey checks it and tells you what's missing
    wildcard: true # `*` points here too

services:
  idea-a:
    repo: ubershmekel/myswe
    branch: main
    deployMode: static
    buildCommand: cd landings/idea-a && npm ci && npm run build
    outputDir: landings/idea-a/dist
    routes: [idea-a.andluck.com]

  andluck-home:
    repo: ubershmekel/myswe
    deployMode: static
    outputDir: landings/home
    routes: [andluck.com, www.andluck.com]

  idea-b-api:
    repo: ubershmekel/myswe
    deployMode: server
    buildCommand: cd services/idea-b-api && npm ci && npm run build
    serverRunCommand: cd services/idea-b-api && npm start
    containerPort: 3000
    env: [DATABASE_URL, STRIPE_KEY] # names only; values set with `sitey env set`
    routes: [idea-b.andluck.com/api]
```

### Top level

| Key        | Required | Meaning                                                                                                    |
| ---------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `version`  | yes      | Format version. Currently `1`.                                                                             |
| `panel`    | no       | Hostname serving the Sitey panel. Maps to the Public Sitey URL setting. See [The panel](#the-panel).       |
| `domains`  | no       | Domains that need settings (DNS provider, wildcard). Hosts under unlisted domains are treated as `manual`. |
| `services` | no       | Map of service name → service. The key is the service's identity.                                          |

### Domains

Keyed by the registrable domain (`andluck.com`), not by host.

| Key        | Default  | Meaning                                                                                                                                                      |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dns`      | `manual` | `namecheap`: Sitey ensures the needed records exist. `manual`: Sitey only checks resolution and reports the records you need to create.                      |
| `wildcard` | `false`  | `false`: records exactly for the hosts in `routes`. `true`: also `*`, so any subdomain resolves here before it's configured, and Sitey claims the namespace. |

With `dns: namecheap`, exact records cost nothing extra — adding a route adds
its record on the next push — so `wildcard: false` is the default. It also means
other subdomains of the same domain can point elsewhere. `wildcard: true` earns
its place mainly with `dns: manual`, where you want to set DNS once.

### Services

Field names mirror `schema.prisma` so the file, the UI, and the code share one
vocabulary. Omitted fields take the schema default, and `export` omits fields
equal to their default.

| Key                | Default | Notes                                                                    |
| ------------------ | ------- | ------------------------------------------------------------------------ |
| `repo`             | —       | `owner/name` on GitHub. Required.                                        |
| `branch`           | `main`  |                                                                          |
| `deployMode`       | —       | `static` or `server`. Required.                                          |
| `buildMode`        | `auto`  | `auto` or `dockerfile`.                                                  |
| `buildCommand`     | `""`    | Multi-line allowed.                                                      |
| `buildImage`       | `""`    |                                                                          |
| `outputDir`        | `""`    | Static only. Relative to repo root.                                      |
| `dockerfilePath`   | `""`    |                                                                          |
| `serverRunCommand` | `""`    |                                                                          |
| `containerPort`    | `3000`  | Server only.                                                             |
| `env`              | `[]`    | Env var **names**. Values never appear in the file.                      |
| `active`           | `true`  | `false` stops the container and removes routes from Caddy, keeping data. |
| `routes`           | `[]`    | Route strings, below.                                                    |

Renaming a service key is a delete plus a create (new id, new data directory).
The diff must say so plainly.

### Routes

A route is a string: `[http://]host[/pathPrefix]`.

- `idea-a.andluck.com` — HTTPS, whole host.
- `idea-b.andluck.com/api` — path prefix.
- `http://127.0.0.1/red` — plain HTTP only (the DB's `httpOnly`).

Hostnames are lowercased. A host may appear on several services only with
distinct path prefixes; duplicates are a validation error.

`apply` derives the DB rows:

- Host under a domain with `wildcard: true` → route on the `*.<domain>` Domain
  row with `subdomain` set. The apex → its own exact Domain row.
- Any other host → an exact Domain row for that host.
- Domain rows no longer referenced by any route or `domains` entry are removed.

### The panel

Today the panel's hostnames come from three places: `SITEY_DOMAIN`, the Public
Sitey URL setting, and `siteySubdomainsEnabled` on every wildcard domain (which
is how one instance ended up serving its panel on three hostnames). In the file
there is one: `panel`.

`apply` sets the Public Sitey URL to `https://<panel>` and turns
`siteySubdomainsEnabled` off on wildcard domains. If `SITEY_DOMAIN` is set in
the environment and differs, `apply` reports a warning, because the env var
wins. The built-in protected `sitey` service does not appear under `services`
and can't be created, changed, or removed from a file.

### What's not in the file

- Runtime state: status, container ids, TLS status, deployments.
- Users, sessions, API tokens.
- Secrets: env var values, webhook secrets, GitHub App credentials, DNS provider
  credentials.
- `letsEncryptEmail`: empty on every real domain so far. Left out; new domains
  get `""`. (Open question: a top-level `acmeEmail` if it's ever needed.)
- `githubMode`: set per repo from whether the GitHub App is configured, not per
  file.

## Why YAML

- **Humans and agents both write it well**, and it allows comments, so the
  committed file can explain itself.
- **It's a schema, not a language.** No new DSL to learn, document, or parse.
- **No executable config.** A TypeScript config would be nicer to compose but
  the server would have to run code it was sent. It parses data instead.
- **Validation for free.** The zod schema can emit JSON Schema for editor
  autocomplete.
- **JSON is for machine output**, not the file: `sitey status --json`, API
  responses. One canonical form, `jq`-friendly, and a truncated JSON document
  fails to parse where truncated YAML can still look valid.

## Authentication: API tokens

The `Token` model already has `type: "session" | "apikey"` and a `name`;
`context.ts` only reads the `sitey_session` cookie.

- Accept `Authorization: Bearer <token>`, looked up by `tokenHash` exactly like
  sessions. API keys have no expiry by default and update `lastUsedAt`.
- The cross-origin guard in `index.ts` already allows requests with no `Origin`
  (what a CLI sends), and bearer tokens aren't sent automatically by browsers,
  so this adds no CSRF exposure.
- **Bootstrap without a UI**: `ssh vps sitey token create home-pc` (the existing
  in-container CLI) prints the token once. Also `token list` and
  `token revoke <name>`. A UI list with revoke buttons can come later.
- A token is **effectively root on the VPS** — Sitey controls the Docker socket.
  Document it that way; the CLI stores it with `chmod 600`.

## API

Two tRPC procedures on `settledProcedure`:

```ts
config.export(): { yaml: string; hash: string }

config.apply(input: {
  yaml: string;
  baseHash?: string;   // hash from the pull this file was based on
  dryRun: boolean;
  force?: boolean;     // ignore baseHash mismatch
}): {
  hash: string;              // hash of the live config after (or, for dry runs, before)
  changes: Change[];         // structured diff: create/update/delete per service, route, domain, DNS record, panel
  warnings: string[];        // e.g. env var named in file has no value; SITEY_DOMAIN overrides panel
  applied: boolean;
}
```

- **The hash** is SHA-256 of the canonical JSON of the _normalized_ document
  (defaults applied, keys sorted), not of the YAML text. Comments and formatting
  don't change it.
- **Conflict check**: if `baseHash` is given, doesn't match the live hash, and
  the file differs from live, reject with a conflict error unless `force`. This
  catches "pulled, then someone edited in the UI, then pushed a stale file".
- **Validation errors** return line/column from the YAML parser where possible.
- `export` must be deterministic: no timestamps, stable ordering, so `pull` →
  commit → `pull` produces no git diff.

## Apply semantics

In order:

1. **Parse and validate** (schema, duplicate hosts, route grammar, unknown keys,
   repos the GitHub App can't see).
2. **Diff** normalized file vs. normalized live export. If `dryRun`, return
   here.
3. **Check `baseHash`.**
4. **Write the DB** in one transaction: services, repos, domains, routes, panel
   setting.
5. **DNS**: for each `dns: namecheap` domain, ensure records (see below). Errors
   are reported per domain and don't roll back the DB.
6. **Reload Caddy.**
7. **Queue deploys** for created services and services whose build/run fields,
   repo, or branch changed. Route-only changes need no redeploy.
8. **Return** the change list and warnings. `apply` doesn't wait for DNS
   propagation, certificates, or builds; `status` reports those.

Safety rules:

- Deleting a service stops and removes its container and routes, never
  `/data/services/<id>/`. (Cleanup can be a separate explicit command.)
- The protected `sitey` service is untouchable.
- Repos no longer referenced are removed only with their services gone; their
  hook endpoints go with them, and the diff says so.
- DNS records are only ever created or updated, never deleted by `apply`.

## Env var values

The file lists names; values are set per service and stored where they are today
(`Service.envVars`).

- `sitey env set <service> <NAME>` reads the value from stdin (never argv, so it
  doesn't land in shell history). `sitey env unset`, `sitey env list <service>`
  (names only).
- A name in the file with no value → warning. A value in the DB whose name isn't
  in the file → warning (not deleted).
- Setting a value restarts or redeploys the service as the UI does today.

## DNS: Namecheap provider

Runs on the server, not the client:

- Namecheap only accepts API calls from **whitelisted IPs**. The VPS has a
  static IP (whitelist it once in the Namecheap dashboard); home machines don't.
- Credentials never leave the server. Set once with
  `sitey dns-provider set namecheap --user <user>` (key read from stdin), stored
  in `SystemConfig` like the GitHub App credentials.
- `ClientIp` is the server's public IP (`SystemConfig.server_ip`).
- Namecheap requires API access to be enabled on the account (it has spending or
  domain-count eligibility rules).

Record logic for a domain with `dns: namecheap`:

- Needed names: the label of each routed host (`@` for the apex), plus `*` if
  `wildcard: true`. Target: the server IP.
- `getHosts` first. If the domain isn't on Namecheap's nameservers
  (`IsUsingOurDNS="false"`), report an error for that domain and write nothing.
- If every needed record already exists with the right address, write nothing.
- Otherwise `setHosts` with **all existing records preserved** plus the added or
  updated ones. `setHosts` replaces the entire record set, so preserving is
  mandatory. An existing A or CNAME record on a needed name pointing elsewhere
  is replaced, and the dry-run diff shows it (`A idea-a 1.2.3.4 → 5.6.7.8`).

Start from `e2e/remote/infra/namecheap.ts`, which already does the
read-merge-write, and fix two bugs before it touches a real domain:

1. **`EmailType` isn't passed back** to `setHosts`. Omitting it can reset the
   domain's email forwarding / MX configuration. Read it from the `getHosts`
   response and send it back.
2. **XML entities aren't decoded.** `getHosts` returns attribute values escaped
   (`&quot;`, `&amp;`), and they're sent back still escaped, which corrupts TXT
   records (SPF, verification strings). Decode on read.

Also preserve every attribute that round-trips (`MXPref`, `TTL`, record types
like `URL`/`URL301`/`FRAME`/`TXT`/`MX`/`CNAME`).

A read-only `sitey dns check <domain>` (current records, needed records, planned
change) ships before DNS is wired into `apply`.

For `dns: manual` domains, `status` checks resolution and lists the records to
create.

## The CLIs

There are two, deliberately:

**In-container CLI** (exists: `server/src/cli.ts`, run on the VPS via the
`sitey` host shim). For install, bootstrap, and recovery — works when the API is
broken or no token exists:

- `generate-password`, `export` (exists)
- `token create <name>`, `token list`, `token revoke <name>` (new)
- `dns-provider set namecheap` (new; also exposed via API so the remote CLI can
  do it)

**Remote CLI** (new workspace, `cli/`). Runs on any machine, talks tRPC over
HTTPS with a bearer token. Uses the server's `AppRouter` type from the monorepo.
Run from a Sitey checkout (`npm run sitey -- ...`) or `npm link`; publishing to
npm can come later.

```
sitey login <name> <url>          # prompts for token; saves profile
sitey servers                      # list profiles
sitey pull   [--server <name>] [-o file]
sitey push   [--server <name>] <file> [--yes] [--force] [--json]
sitey status [--server <name>] [--json]
sitey deploy [--server <name>] <service>
sitey env set|unset|list [--server <name>] <service> [NAME]
sitey dns check [--server <name>] <domain>
```

- Profiles live in `~/.config/sitey/servers.json`, mode `600`. A single profile
  is the default; `SITEY_SERVER` env var overrides.
- `pull` writes `.sitey-base` metadata (server + hash) next to the file, or a
  comment header the CLI reads back, so `push` can send `baseHash` without the
  user thinking about it. (Pick one during implementation; the header comment is
  simpler and survives being committed.)
- `push` always does a dry run first and prints the diff. Interactive: asks to
  confirm. `--yes`: applies without asking (for agents). `--json`: prints the
  structured result.
- `status` reports per service: last deploy result, and per route host: DNS
  resolves here, certificate valid, HTTP status. This is how an agent verifies a
  launch.
- Exit codes: 0 success, 1 error, 2 validation error, 3 conflict. Agents branch
  on these.

## Content: where pages come from

- **The `myswe` repo is private** on GitHub, with landing pages in folders
  (`landings/idea-a/`, …). The folder name matches the subdomain by convention.
- The new Sitey instance has the **GitHub App installed on `myswe`** — a
  one-time step per VPS. That also gives push-to-deploy via the App's webhook.
- Each service clones the repo separately into `/data/services/<id>/repo`. Fine
  for a handful of pages; revisit if it becomes dozens.
- **Push content before config.** Sitey clones from GitHub, so a service whose
  folder isn't pushed yet fails its first deploy.

Future convenience, not now: one service entry that expands each folder under
`landings/` into `<folder>.andluck.com`. Wait until the double edit (folder +
service block) actually hurts.

## Flows

### New VPS (once)

1. Create the VPS; run the one-line install.
2. Log in at `http://<ip>`, connect the GitHub App, install it on `myswe`.
3. `ssh vps sitey token create home-pc`; on the home machine
   `sitey login andluck https://sitey.andluck.com` (after DNS below).
4. Whitelist the VPS IP in Namecheap API settings;
   `sitey dns-provider set namecheap --user ubershmekel`.
5. Write `sitey/andluck.yaml` with `panel: sitey.andluck.com` and
   `domains: andluck.com: { dns: namecheap }`, push it. Sitey creates the
   `sitey` A record and serves the panel over HTTPS.

(Step 3 briefly needs the IP URL; the CLI accepts `http://<ip>` for first login,
with a warning.)

### New landing page (the common case)

```sh
# in myswe
mkdir landings/idea-b && ...                      # agent builds the page
sitey pull -o sitey/andluck.yaml                  # refresh from live
# agent adds a service block: routes: [idea-b.andluck.com]
git add -A && git commit -m "idea-b landing" && git push
sitey push sitey/andluck.yaml --yes --json        # diff → DB → DNS record → Caddy → deploy
sitey status --json                               # poll until DNS ✓, cert ✓, HTTP 200
```

### New domain I already bought

Add `newdomain.com: { dns: namecheap }` under `domains`, add routes using it,
push. No Namecheap dashboard.

### Moving the redditp panel (one-off, manual)

The existing instance serves its panel at `sitey.s.andluck.com`. Set its Public
Sitey URL to `sitey.redditp.com` first and confirm it loads. Then point
`andluck.com` records at the new VPS. `*.s.andluck.com` keeps resolving to the
old box meanwhile, because DNS prefers the more specific wildcard.

## Build order

Each phase is shippable and testable on its own.

1. **Format, schema, deterministic export.** zod schema for the format above;
   rewrite `server/src/services/export.ts` to emit it (routes as strings,
   `repo: owner/name`, services keyed by name, `panel`, `domains` only where
   needed, no timestamp); normalized-document hash. Unit tests with fixtures,
   including the orphan and duplicate cases.
2. **API tokens.** Bearer auth in `context.ts`; `sitey token create|list|revoke`
   in the in-container CLI. Tests for expired/revoked/unknown tokens.
3. **`config.export` and `config.apply` with dry run.** Parser, validation
   errors with positions, structured diff. Key test: `apply(export())` on
   fixtures reports zero changes.
4. **Remote CLI**: `login`, `servers`, `pull`, `push` (dry run only at this
   stage), `status` (deploy state only).
5. **Apply for real.** DB transaction, `baseHash` conflict check, safety rules,
   Caddy reload, deploy queueing, panel handling. `push` confirms and applies;
   `deploy` command.
6. **Env values.** `sitey env set|unset|list`; warnings in apply.
7. **Namecheap.** Move the provider into the server with the `EmailType` and
   entity fixes; `dns-provider set`; read-only `dns check`; then wire into
   `apply`. `status` gains DNS/TLS/HTTP checks per host.
8. **Agent guide.** A short doc (or a skill file in `myswe`) covering: add a
   page, add a domain, verify, what needs a human.

First real use after phase 5 on the new VPS with `dns: manual`; switch
`andluck.com` to `dns: namecheap` after phase 7.

## Open questions

- Pull metadata: header comment vs. sidecar file for `baseHash`.
- Whether the in-container CLI and remote CLI should eventually merge (remote
  CLI with a `--local` transport).
- `acmeEmail` at the top level, if Let's Encrypt notifications turn out to
  matter.
- Whether to show a "last applied from CLI by token X" marker in the UI, so UI
  edits over a committed file are less surprising.
