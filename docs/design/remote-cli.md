# Remote CLI and config export

An agent on my home machine should be able to launch a landing page on a Sitey
VPS end to end — create the service, route a hostname to it, deploy, and verify
it's live — over HTTPS, without SSH and without clicking through the UI. The
server's configuration should also be exportable as YAML so it can be committed,
diffed over time, and used as an inventory.

This document proposes a remote CLI, `siteyctl`, that drives the existing tRPC
API with an API token, plus a deterministic read-only export. Nothing here is
implemented yet; today there is only the VPS-local `sitey export` preview.

The motivating setup: landing pages live in folders of the private
`ubershmekel/myswe` repo, and are served on subdomains of `andluck.com` by a new
VPS whose panel is `sitey.andluck.com`.

## Goals

- **An agent can launch a landing page end to end** with a handful of commands,
  and can tell a real launch from a placeholder page.
- **No SSH for day-to-day work.** SSH is for install, token creation, and
  recovery.
- **Several VPSes from one machine**: `siteyctl --server andluck ...`.
- **A readable, deterministic export** that can be committed to git so config
  changes show up as diffs over time.
- **The one-line install, the VPS-local `sitey` command, and the web UI keep
  working as they are.**

## Non-goals (for now)

- **Applying YAML back to the server** (declarative sync). See
  [Why not YAML apply](#why-not-yaml-apply-yet).
- **DNS automation.** DNS is set once per domain by a human (apex + wildcard A
  records). Sitey only needs to use those domains.
- **Secrets in files.** Env var names can be listed; values are write-only.
- **Moving services or data between VPSes**, team GitOps, managing the VPS OS,
  buying domains.

## How it fits

```
 home machine                                  VPS (sitey.andluck.com)
 ────────────                                  ───────────────────────
 myswe/ (private repo)
 ├── landings/idea-a/    git push ──▶ GitHub ──clone (GitHub App)──▶ sitey-api
 └── sitey/andluck.yaml                                               │
        ▲                                                             ├─▶ SQLite
        │ export                                                      ├─▶ Caddy
   siteyctl ◀──────── HTTPS + bearer token (tRPC) ───────────────────▶├─▶ deploy queue
                                                                      └─▶ TLS/HTTP probes
```

`siteyctl` is a thin client. It calls the same tRPC procedures the UI calls, so
validation, Caddy reloads, and deploy queueing stay in one place on the server.
The DB remains the only source of truth.

## Why not YAML apply (yet)

An earlier revision of this doc made YAML the write path: pull, edit, push, and
the server diffs and applies the whole file. Reviewing it against a real
instance showed that full-snapshot sync is where nearly all the complexity comes
from:

- Omission has to mean something. Is a missing service deleted, or was the file
  truncated? That needs prune flags and rules per collection.
- Renaming a key looks like delete + create, which would lose the data
  directory, deployment history, and analytics. That needs a separate identity
  column or ids in the file.
- Stale files need conflict detection (base hashes, revisions, bound plans).
- Settings the format doesn't express (unused domain allocations, per-domain
  panel subdomains, repo integration modes) get reset unless the format grows to
  cover every one of them.
- DB writes, Caddy reloads, and deploys can't share a transaction, so partial
  applies need recording and recovery.

An agent launching pages doesn't need any of that. It needs to do five specific
things, each of which is already a tRPC mutation. Imperative commands have no
omission semantics, no rename problem, and no stale-file problem.

YAML stays as an export: an inventory, a history in git, and a starting point
for a future `import` into an empty instance.

Findings from that review that still apply here:

- `services.delete` removes the service's files and cascades to its deployments.
  The CLI must not make that easy to do by accident.
- A 200 response is not proof of launch: routes without a deployment serve
  `pending.html` with 200.
- HTTP-01 cannot issue wildcard certificates. Wildcard DNS is fine; each routed
  host gets its own certificate, as today.

## One-time human setup

### Per VPS

1. Run the one-line install. Log in, set the Public Sitey URL, connect the
   GitHub App, and install it on the accounts/repos to deploy (`myswe`).
2. Create a token on the VPS: `ssh vps sitey token create home-pc`. It prints
   once.
3. On the home machine: `siteyctl login andluck https://sitey.andluck.com` and
   paste the token.

### Per domain

1. At Namecheap (or any DNS host), create two A records pointing at the VPS: `@`
   and `*`. For a nested namespace like `*.s.andluck.com`, create `*.s` instead.
2. Add the domains to Sitey once, in the UI or with
   `siteyctl domain add andluck.com` and `siteyctl domain add '*.andluck.com'`.

After that, any `<label>.andluck.com` route works without touching DNS again.
Subdomain routes use the wildcard Domain row with `subdomain` set, which Sitey
already supports.

## Naming: `siteyctl`

The VPS already has a `sitey` command (`deploy/sitey`, which runs
`server/src/cli.ts` inside the container) for local tasks like
`generate-password` and `export`. Giving the remote client the same name would
mean `sitey token create` does different things depending on which machine
you're on.

So the remote client is **`siteyctl`** — "control a Sitey server", in the style
of `kubectl` and `systemctl`. The VPS-local `sitey` stays for install, recovery,
and token management, and works when the API is down.

## Server changes

### API tokens

The `Token` model already has `type: "session" | "apikey"` and `name`;
`context.ts` only reads the `sitey_session` cookie.

- Accept `Authorization: Bearer <token>`, looked up by `tokenHash` exactly like
  sessions. Only `type: "apikey"` is accepted this way. API keys don't expire by
  default and update `lastUsedAt` like sessions do.
- The origin check in `index.ts` already allows requests without an `Origin`
  header, and browsers never attach bearer tokens on their own, so this adds no
  CSRF exposure.
- VPS-local `sitey token create <name>`, `token list`, `token revoke <name>`. A
  UI list with revoke buttons can come later.
- A token is **root-equivalent on the VPS**, because Sitey controls the Docker
  socket. Document it that way.

### Service ids and names

No string in this design is a permanent identifier. A service's only permanent
identity is the numeric id it already has, which is what container names
(`sitey-service-42`), data directories (`/data/services/42/`), deployments, and
analytics already use. Names are labels: unique, but always editable.

- Names are unique so `siteyctl deploy idea-a` is unambiguous and a retried
  `service create idea-a` fails instead of creating a duplicate. Names already
  match `^[a-z0-9-]+$` and are at most 40 characters.
- Migration: add a unique index on `Service.name`. Before adding it, rename
  duplicates and id-like names deterministically (`name-<id>`), and log each
  rename.
- `services.create` and `services.update` return `CONFLICT` for a taken name.
- Renaming updates the row in place, so the id, data directory, deployments, and
  analytics stay attached. The UI can already do this; `siteyctl service rename`
  does the same.
- Wherever the CLI takes a `<service>`, it accepts either the current name or
  the id, written `service-42` or `42`. Names can't be purely numeric or start
  with `service-<digits>`, so the two forms never collide.
- The export keys services by `service-<id>`, not by name. See
  [The export](#the-export).

### Routes by hostname

In the UI, adding a route means picking a Domain row from a dropdown, then
typing a subdomain (for wildcard domains) and an optional path prefix. The CLI
takes a single URL-like string instead, `[http://]host[/pathPrefix]`, and the
server works out which Domain row and subdomain it means.

Suppose the server has these Domain rows: `andluck.com`, `*.andluck.com`,
`*.s.andluck.com`, and `localhost`.

| Command                                                | Domain row        | Subdomain | Path prefix | HTTPS |
| ------------------------------------------------------ | ----------------- | --------- | ----------- | ----- |
| `siteyctl route add idea-a idea-a.andluck.com`         | `*.andluck.com`   | `idea-a`  |             | yes   |
| `siteyctl route add home andluck.com`                  | `andluck.com`     |           |             | yes   |
| `siteyctl route add home www.andluck.com`              | `*.andluck.com`   | `www`     |             | yes   |
| `siteyctl route add idea-b-api idea-b.andluck.com/api` | `*.andluck.com`   | `idea-b`  | `/api`      | yes   |
| `siteyctl route add demo demo.s.andluck.com`           | `*.s.andluck.com` | `demo`    |             | yes   |
| `siteyctl route add red http://localhost/red`          | `localhost`       |           | `/red`      | no    |
| `siteyctl route add idea-a a.b.andluck.com`            | error             |           |             |       |
| `siteyctl route add idea-a shop.example.com`           | error             |           |             |       |

The rules, in order:

1. If there's a Domain row for exactly `host`, use it. (If someone later adds a
   `www.andluck.com` row, new `www` routes go there instead of the wildcard.)
2. Otherwise, use the most specific wildcard row `*.<rest>` where `host` is
   `<label>.<rest>` and `<label>` is a single DNS label, with
   `subdomain: <label>`. That's why `demo.s.andluck.com` lands on
   `*.s.andluck.com`, and why `a.b.andluck.com` matches nothing: `a.b` isn't one
   label, and there's no `*.b.andluck.com` row.
3. Otherwise, fail with a hint:
   `No domain covers shop.example.com. Add one with siteyctl domain add`.

Route strings never create domains implicitly. `route remove` resolves the
string the same way to find the route to delete, and `siteyctl service get` and
the export print routes back in this form.

Add an optional `host` input to `addRoute` (mutually exclusive with
`domainId`/`subdomain`) so the UI and CLI share the resolver. Adding a route
that already exists on the same service is a no-op success, so agents can rerun
it. Adding one that another service already has is a conflict (exit 3).

### Env vars by name

`envVars` is stored as one `.env`-format string, and today the only write is a
whole-string `services.update`. Add `services.setEnvVar({ id, name, value })`
and `services.unsetEnvVar({ id, name })`, which edit one entry using the same
parser as deployment. Reads for the CLI return names only. Saving a value does
not redeploy, matching the UI.

### Detecting the pending page

Have Caddy set a response header (`X-Sitey-Pending: 1`) wherever it rewrites to
`pending.html`, so verification can tell a placeholder from a deployed site
without matching page content.

## `siteyctl` commands

A new `siteyctl/` workspace that imports the server's `AppRouter` type. (Not
`cli/`, which would be confused with the existing VPS-local CLI in
`server/src/cli.ts`.) Run from a checkout with `npm run siteyctl -- ...`;
publishing a `siteyctl` npm package can come later.

```text
siteyctl login <server-name> <url>            # prompts for token, saves profile
siteyctl servers                               # list profiles

siteyctl services                              # list: id, name, mode, status, routes
siteyctl service get <service>
siteyctl service create <name> --repo owner/name --static|--server
         [--branch main] [--build-command ...] [--build-image ...]
         [--output-dir ...] [--run-command ...] [--port 3000]
         [--dockerfile [path]] [--route <route>]...
siteyctl service set <service> --build-command ... [other fields]
siteyctl service rename <service> <new-name>
siteyctl service deactivate|activate <service>
siteyctl service delete <service> --confirm <name>   # deletes files and history

siteyctl route add <service> <route>
siteyctl route remove <service> <route>

siteyctl env list <service>                    # names only
siteyctl env set <service> <VAR>               # value from stdin
siteyctl env unset <service> <VAR>

siteyctl deploy <service> [--wait] [--timeout 300]
siteyctl status [<service>] [--wait] [--timeout 300]
siteyctl logs <service> [--deployment <id>] [--tail 200]

siteyctl domains
siteyctl domain add <hostname> [--email ...]

siteyctl export [-o file]
```

Conventions:

- `<service>` is a current name or an id (`service-42` or `42`).
  `service create` prints the new id, and `--json` output always includes it, so
  scripts that must survive renames can hold on to the id.
- Every command accepts `--server <name>`, overriding `SITEY_SERVER`, then the
  only profile. With several profiles and none selected, the command fails.
- `--json` prints the result to stdout; diagnostics go to stderr.
- Exit codes: 0 success, 1 error, 2 validation, 3 conflict or not found, 4
  timeout.
- `service create` defaults to the GitHub App integration and fails early if the
  App can't see the repo. `--github-mode webhook` is available for repos without
  the App. It queues the first deploy, as the UI does, then adds any `--route`s.
- `service delete` is deliberately awkward. Prefer `deactivate`, which stops the
  container and removes routes from Caddy while keeping data.
- Env values come from stdin, never argv, so they don't land in shell history.
  They are never printed.
- Profiles live in `~/.config/sitey/servers.json` (`%APPDATA%\sitey` on Windows)
  with owner-only permissions. The CLI requires HTTPS, except for `localhost` /
  `127.0.0.1` URLs (an SSH tunnel).

### Help is the agent guide

There's no separate agent guide to keep in sync. An agent learns the tool by
running `siteyctl --help` and `siteyctl <command> --help`, so the help text is
written for that reader:

- Top-level help lists the commands, then an **Examples** section with the
  common workflows: launch a page (create → `status --wait` → export), add a
  route, set an env var, retire a page, and snapshot the export to git.
- A **Needs a human** section: DNS records, adding the GitHub App to a repo, and
  creating tokens (`ssh <vps> sitey token create`).
- The `<service>` and route string forms, `--json`, and exit codes.
- Each command's help has at least one concrete example, and errors that have an
  obvious next step print it (as in the "No domain covers" hint).

Things specific to one project, like "landing pages live in `landings/<name>/`
and go on `<name>.andluck.com`", belong in that repo's `AGENTS.md`, along with a
line saying to run `siteyctl --help`.

### What `status --wait` checks

For each route of the service:

1. The latest deployment finished with `success` (or, for `deploy --wait`, the
   deployment that command queued).
2. For HTTPS routes, the certificate is valid for the host.
3. A GET of the route URL returns 2xx without `X-Sitey-Pending`, following at
   most five redirects on the same host (http→https upgrades allowed).

It prints each check and exits 0 when all pass, or 4 when `--timeout` is
reached, showing which check was still failing. Server apps whose root
legitimately returns 401 or 404 show the deploy result and raw HTTP status
separately rather than being called "live". Custom health checks can come later.

## The export

`sitey export` exists today, but it's a preview. It has a timestamp header,
lists repos and domains as separate collections, and represents routes as
`{domain, subdomain}` objects. Rework `server/src/services/export.ts` so the
output is readable and stable, and serve it to the CLI through
`system.exportConfig`:

```yaml
# Sitey config export. Read-only: nothing reads this file back yet.
# Excludes runtime state, deployments, users/tokens, and secret values.
version: 1
panel: https://sitey.andluck.com

domains:
  - andluck.com
  - "*.andluck.com"
  - hostname: "*.s.andluck.com"
    siteySubdomains: true

services:
  service-42:
    name: idea-a
    repo: ubershmekel/myswe
    deployMode: static
    buildImage: node:24-bookworm-slim
    buildCommand: cd landings/idea-a && npm ci && npm run build
    outputDir: landings/idea-a/dist
    routes: [idea-a.andluck.com]

  service-43:
    name: idea-b-api
    repo: ubershmekel/myswe
    deployMode: server
    serverRunCommand: cd services/idea-b-api && npm start
    env: [DATABASE_URL, STRIPE_KEY]
    routes: [idea-b.andluck.com/api]
```

- Services are keyed by `service-<id>`, with `name` as an ordinary field. A
  rename is then a one-line `name:` change in the diff rather than a block that
  disappears under one key and reappears under another. Ids are local to one
  instance; a future `import` into another instance ignores the keys and assigns
  new ids.
- Routes are written as the same strings the CLI accepts.
- Fields equal to their schema default are omitted. Domains with no non-default
  settings are plain strings.
- No timestamps; sorted keys and lists. Exporting twice gives identical bytes.
- The protected `sitey` service is omitted; `panel` shows where the panel lives.

### History in git

The export doesn't change the server. It gives git something to diff. The
convention for the agent (and me):

```sh
siteyctl route add idea-c idea-c.andluck.com     # change the server
siteyctl export -o sitey/andluck.yaml            # snapshot it
git add sitey/andluck.yaml && git commit -m "Route idea-c.andluck.com"
```

`git log -p sitey/andluck.yaml` then reads as a history of the server's
configuration: which service was added, which route moved, when a build command
changed. Edits made in the UI between snapshots appear in the next commit's
diff, so nothing goes unrecorded. They're just attributed to whoever exported
next.

This is an audit trail after the fact, not review before the change. Reviewing
before applying would need the plan/apply machinery this doc defers. For one
person and an agent operating on landing pages, after-the-fact history is
enough. If it isn't, `siteyctl` can grow a `--dry-run` on individual commands
before it grows a declarative engine.

## Flows

### New landing page

```sh
# in myswe: build landings/idea-c/, commit, and push to GitHub first —
# Sitey clones from GitHub, so unpushed content fails the first deploy.
siteyctl service create idea-c --repo ubershmekel/myswe --static \
  --build-image node:24-bookworm-slim \
  --build-command "cd landings/idea-c && npm ci && npm run build" \
  --output-dir landings/idea-c/dist \
  --route idea-c.andluck.com
siteyctl status idea-c --wait --timeout 300 --json
siteyctl export -o sitey/andluck.yaml && git commit -am "Launch idea-c"
```

Content updates after that are pushes to `myswe`; the GitHub App webhook
redeploys.

### New domain

Buy it, add the `@` and `*` A records, then `siteyctl domain add example.com`
and `siteyctl domain add '*.example.com'`.

### Retire a page

`siteyctl service deactivate idea-c` stops serving it and keeps its data.
`siteyctl service delete idea-c --confirm idea-c` removes it for good.

## Build order

Each step is usable on its own.

1. **Tokens.** Bearer auth in `context.ts`; `sitey token create|list|revoke` in
   the VPS-local CLI. Tests: unknown, revoked, expired, and session-type tokens
   sent as bearer are rejected.
2. **Unique names.** Migration with duplicate renaming; `CONFLICT` on create and
   update. Tests: duplicate backfill, rename keeps id and routes, names that
   look like ids are rejected.
3. **`siteyctl` read-only.** Workspace, profiles, `login`, `servers`,
   `services`, `service get`, `domains`, `logs`, and the reworked `export`.
   Tests: export is byte-identical across runs; `--json` and exit codes.
4. **Writes.** `addRoute` host resolver, env procedures,
   `service create|set|rename|activate|deactivate|delete`, `route add|remove`,
   `env set|unset|list`, `domain add`. Tests: resolver picks the exact row, then
   the most specific wildcard; rerunning `route add` is a no-op; env values
   never appear in output.
5. **Deploy and verify.** `X-Sitey-Pending` header, `deploy --wait`,
   `status --wait`. Tests: the pending page is not live; TLS failure and timeout
   report which check failed.
6. **Help text.** Examples and "Needs a human" sections as described in
   [Help is the agent guide](#help-is-the-agent-guide); a few lines in
   `myswe/AGENTS.md`. Test: every example in the help text parses as a valid
   command. Try it by giving a fresh agent only `siteyctl --help` and asking it
   to launch a page.

## Later

- **`siteyctl import <file>`** into an empty instance, to rebuild a VPS or clone
  a setup. Create-only, so it has none of the apply problems above.
- **Declarative apply**, if imperative commands plus export history stop being
  enough. The earlier revision of this doc (commit `a232fd7`) records the
  requirements: prune-gated omission, identity separate from name,
  revision-bound plans, and recoverable external work.
- **DNS automation** via the Namecheap API (`e2e/remote/infra/namecheap.ts` is a
  starting point). `setHosts` replaces the whole record set, so it must
  round-trip `EmailType`, `MXPref`, `TTL`, and XML-escaped TXT values before
  touching a real domain.
- **Team mode**: a config repo triggering the same code on push.

## Open questions

- Should `siteyctl` offer an auto-export option in its profile, so the snapshot
  step can't be forgotten? Probably not for now.
- Should token creation also be possible from the UI, so first setup needs no
  SSH at all? Yes. We have most of the ui for this in the settings page. Also in
  theory we could have the agent ssh in to install sitey on a new vps. But no
  rush to implement these.
- Is `panel` plus per-domain `siteySubdomains` the right way to show panel
  hostnames in the export, or should the export list the effective hostnames?
  "panel" is a strange name. Which panel wherre? It should probably be called
  "Sitey Effective URL" or whatever it's called in the sitey ui, what the agent
  needs to use in siteyctl as an address and a human logs into.
