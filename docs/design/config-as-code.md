# Config as code (YAML + remote CLI)

Sitey's configuration can be pulled as YAML, edited by a human or an agent,
committed to git, and pushed back over HTTPS. The DB stays authoritative and the
web UI remains available. This document specifies proposed behavior; the current
export is a preview and the remote CLI/apply system is not implemented yet.

The motivating use case is an agent launching landing pages from the private
`ubershmekel/myswe` repository on `sitey.andluck.com`, including Namecheap DNS,
deployment, and verification. Installation and account consent remain human
bootstrap tasks; everyday work should not require SSH.

## Goals and scope

- Review actual configuration changes with deterministic exports.
- Keep UI/CLI edits compatible and detect stale files or plans.
- Preserve service identity, data, deployment history, and analytics on rename.
- Allocate domains and wildcards independently of routes.
- Manage independent VPS profiles with `sitey --server <name>`.
- Recover interrupted DNS, Caddy, and deployment work after restarts.
- Keep the installer and website usable without a config repository.

Initially excluded: buying domains, managing the VPS OS, moving data between
VPSes, team GitOps, prebuilt registry-image deployments, and secrets in YAML.
Environment values may remain website-managed in the core release; a small env
CLI follows later.

## Background and alternatives

All configuration currently lives in SQLite. A remote CLI adds inventory,
reviewable changes, and repeatable setup without requiring host-level SSH for
every deployment. YAML is a snapshot, not a backup of application data.

| Alternative                     | Reason for this design instead                                       |
| ------------------------------- | -------------------------------------------------------------------- |
| Arbitrary SSH commands          | Hard to review or reproduce; bypasses Sitey's invariants.            |
| Separate landing-page deployer  | Duplicates routing, TLS, deployment, and analytics.                  |
| Git push directly to the VPS    | Adds host-level SSH users/hooks outside the current architecture.    |
| Terraform provider              | Adds another state-management workflow and provider implementation.  |
| YAML edited on the VPS          | Does not provide the home-machine workflow or git history by itself. |
| Server pulls config from GitHub | Useful later for teams; more setup than personal push/pull requires. |

## Principles

1. **The DB is authoritative.** Clients share server-side parsing, validation,
   planning, and apply logic.
2. **Review the actual change.** Apply requires a plan bound to the destination
   instance and current configuration revision.
3. **Names are editable; identity is stable.** Rename never creates a new data
   directory or analytics identity.
4. **No implicit destruction.** Omission cannot silently remove resources.
   Explicit pruning archives services; it never purges data.
5. **Configuration and delivery are separate.** DNS, Docker, and Caddy cannot
   share a DB transaction. Persist and retry their work.
6. **Round-trip existing intent.** Preserve unused allocations, environment
   declarations, aliases, and nondefault settings.
7. **Idempotent desired state.** Unchanged configuration produces no new changes
   or duplicate jobs, but unfinished delivery still resumes.

## The file format

Use YAML 1.2, the `yaml` package, and a strict zod schema. Reject unknown keys,
duplicate mapping keys, unsupported tags, multiple documents, and excessive
input size or alias expansion. YAML is data, never executable configuration.
Emit JSON Schema for editor assistance.

```yaml
version: 1
panel: sitey.andluck.com
panelAliases: []

# Zone policy alone allocates neither its apex nor its wildcard.
dns:
  andluck.com:
    provider: namecheap
  redditp.com:
    provider: manual

# Explicit allocations survive without service routes.
# Quote a leading asterisk: unquoted '*' is YAML alias syntax.
domains:
  andluck.com: {}
  "*.redditp.com": {}

services:
  idea-a: # stable configKey; change name below to rename
    name: idea-a
    repo: ubershmekel/myswe
    branch: main
    deployMode: static
    buildImage: node:24-bookworm-slim
    buildCommand: cd landings/idea-a && npm ci && npm run build
    outputDir: landings/idea-a/dist
    routes: [idea-a.andluck.com]

  andluck-home:
    name: andluck-home
    repo: ubershmekel/myswe
    deployMode: static
    outputDir: landings/home
    routes: [andluck.com, www.andluck.com]

  idea-b-api:
    name: idea-b-api
    repo: ubershmekel/myswe
    deployMode: server
    buildMode: auto
    buildImage: node:24-bookworm-slim
    buildCommand: cd services/idea-b-api && npm ci && npm run build
    serverRunCommand: cd services/idea-b-api && npm start
    containerPort: 3000
    env: [DATABASE_URL, STRIPE_KEY] # declarations, never values
    routes: [idea-b.andluck.com/api]
```

### Top level and omission rules

| Key            | Required | Meaning                                                             |
| -------------- | -------- | ------------------------------------------------------------------- |
| `version`      | yes      | Format version, initially `1`.                                      |
| `panel`        | no       | Canonical panel URL; a hostname means HTTPS. Omission preserves it. |
| `panelAliases` | no       | Additional panel hostnames. Omission preserves; `[]` removes.       |
| `dns`          | yes      | Map of DNS zone to provider policy; use `{}` for none.              |
| `domains`      | yes      | Map of explicit hostname/wildcard allocations; use `{}` for none.   |
| `services`     | yes      | Map of stable configuration key to complete service definition.     |

This is an instance-wide snapshot, not a patch format. All collection keys are
required so a file cut off before `services` cannot mean an empty server. If
live entries are absent from a collection, planning rejects the file unless
`--prune` was supplied, listing the omissions. `--yes` only skips interactive
confirmation; it does not enable pruning.

With `--prune`, omitted services are archived, omitted explicit allocations are
released, and omitted DNS policies become manual. Show every effect in the plan.
DNS records are never automatically deleted. Within included services, omitted
fields use documented defaults, including `routes: []`; show those changes too.
To pause a service, prefer `active: false`.

Export includes all collections, canonical panel when set, and `panelAliases`
even when empty. Normalize set-like arrays and ordering. Defaults belong to the
format version, not whatever Prisma defaults exist after an upgrade. Repeated
export must produce the same YAML.

### Service identity: how the string maps to the existing ID

Add a unique, persistent **`Service.configKey` string**. Keep the existing
numeric **`Service.id` unchanged**. The YAML map key is looked up in this new DB
column; it is not converted to a number and is not a hash of the name.

For example, the DB contains:

| id  | configKey | name   |
| --- | --------- | ------ |
| 42  | idea-a    | idea-a |

In the service portion of the same file, the user changes only `name` (the
top-level fields and other services remain present):

```yaml
services:
  idea-a:
    name: better-name
    repo: ubershmekel/myswe
    branch: main
    deployMode: static
    buildImage: node:24-bookworm-slim
    buildCommand: cd landings/idea-a && npm ci && npm run build
    outputDir: landings/idea-a/dist
    routes: [idea-a.andluck.com]
```

Apply finds `Service.configKey == "idea-a"` and updates row **42**:

| id  | configKey | name        |
| --- | --------- | ----------- |
| 42  | idea-a    | better-name |

`/data/services/42/`, container identity, deployment foreign keys, and analytics
`service_id = 42` remain attached to the same service. No data moves. UI
renaming also changes only `name`.

- Require `name` explicitly; it is never a lookup key. Keep current name
  validation; names need not become globally unique.
- Keys use lowercase letters, digits, and hyphens, with bounded length. Enforce
  uniqueness in SQLite, including archived services.
- Backfill once during migration. Prefer unique valid names; resolve empty or
  duplicate names deterministically with ID suffixes and collision checks. Store
  the result; never regenerate on export or rename.
- UI-created services receive a key once using the same allocator. Show/copy it
  in the UI for CLI use.
- A new key creates a row with a new numeric ID. An existing key updates its
  row. Numeric DB IDs are not accepted in version 1 YAML.
- Editing a key means a different identity. Without `--prune`, omission of the
  old key blocks planning. With it, show archive-old/create-new and warn that
  data is not transferred. A future explicit key-rename operation can preserve
  the ID; normal renaming uses `name`.
- Archived keys remain reserved. Reintroducing one requires explicit restore;
  never attach an unrelated app to archived data silently.
- Keys are instance-local. On an empty second VPS, `idea-a` might receive ID 7.
  That copies configuration, not data or analytics. On a populated target,
  matching keys are explicit updates in the import plan, never inferred matches
  by display name.

### Services and images

| Key                | Default | Notes                                                           |
| ------------------ | ------- | --------------------------------------------------------------- |
| `name`             | none    | Required editable name, separate from the key.                  |
| `repo`             | none    | Required GitHub `owner/name`.                                   |
| `branch`           | `main`  | Planning resolves intended deployment commits.                  |
| `deployMode`       | none    | Required: `static` or `server`.                                 |
| `buildMode`        | `auto`  | `auto` or `dockerfile`; Dockerfile mode is for servers.         |
| `buildCommand`     | `""`    | Build command; multiline allowed.                               |
| `buildImage`       | `""`    | Static build container or auto-built server base image.         |
| `outputDir`        | `""`    | Static output relative to repo root; empty means repo root.     |
| `dockerfilePath`   | `""`    | Relative path; empty uses existing default resolution.          |
| `serverRunCommand` | `""`    | Command for the generated server image.                         |
| `containerPort`    | `3000`  | Server port, integer 1–65535.                                   |
| `env`              | `[]`    | Declared names, never values.                                   |
| `active`           | `true`  | False stops serving/container while retaining service and data. |
| `routes`           | `[]`    | Concrete route strings.                                         |

Today `buildImage` has two uses. For static sites, nonempty runs the build in
that image; empty retains the API-container build behavior. For an auto-built
server, it supplies Dockerfile `FROM`; empty currently selects
`node:24-bookworm-slim`. The examples make both environments explicit. Correct
the static-only Prisma comment during implementation.

In Dockerfile mode, the repository Dockerfile controls base image and run
command. Warn on retained unused auto-build fields rather than pretending they
override it or rejecting an otherwise valid existing export.

The final service image, currently tagged by service ID and commit, is build
output and is not exported. Prebuilt-image deployment needs a future `image`
source mutually exclusive with `repo`/build fields, plus registry authentication
and deployment semantics. It is not another meaning of `buildImage`.

### DNS zones and domain allocations

Separate provider policy from allocation:

```yaml
dns:
  andluck.com: { provider: namecheap }
domains:
  "*.s.andluck.com": {}
```

This allocates `*.s.andluck.com` within zone `andluck.com`; the provider record
name is `*.s`, not `*`. No service route is needed.

- Policies use `provider: manual | namecheap`, initially one account per
  provider. Named credential profiles can follow later.
- Match the longest configured zone on label boundaries; unlisted zones are
  manual. Validate managed zones/delegation with the provider. Do not guess a
  zone from the last two labels (`example.co.uk` is a counterexample).
- Allocation keys are exact hosts or leading `*.` wildcards, including nested
  wildcards. Canonicalize names and reject duplicate equivalents.
- Allocations may include `letsEncryptEmail`, default `""`, preserving existing
  settings. Reject conflicting effective email settings for the same concrete
  TLS host. Allocation alone does not trigger wildcard certificate issuance.
- Persist explicit allocation ownership. UI-created domains are explicit; hosts
  created solely for routes/panel references are derived. Migration treats every
  existing domain as explicit because historical intent cannot safely be
  inferred.
- Explicit allocations survive without routes and always export. Release
  requires removal with `--prune` or an explicit UI action. If a route still
  needs the host, retain a derived row. Derived rows may disappear after their
  last reference.

An apex allocation requests/checks its apex record. A wildcard requests/checks
that wildcard, not its apex. Zone policy alone allocates neither. For concrete
route hosts, use an allocated wildcard when it actually resolves correctly;
create exact records when needed and show the choice in the plan. Existing
records or delegations can take precedence; check actual resolution, including
stale AAAA.

Wildcard DNS does not mean wildcard routing or certificates. Version 1 serves
concrete configured hosts and gets certificates for those hosts. Unknown hosts
must not select an arbitrary service. True wildcard certificates require
separate DNS-based ACME integration; HTTP-01 cannot issue them. See the
[YAML specification](https://yaml.org/spec/1.2.2/) for quoted strings and
[Let's Encrypt challenge documentation](https://letsencrypt.org/docs/challenge-types/).

### Routes

A route is `[http://|https://]host[/pathPrefix]`, default HTTPS:

- `idea-a.andluck.com`: whole host.
- `idea-b.andluck.com/api`: prefix route.
- `http://127.0.0.1/red`: plain HTTP for an IP host.

Normalize host case, default scheme, and equivalent root/trailing-slash forms.
Reject credentials, queries, fragments, unsupported ports, wildcard route hosts,
malformed hosts, and unsafe Caddy prefixes. Validate repo-relative paths against
escaping their intended root too.

Host/path pairs must be unique across services regardless of exact/wildcard DB
representation. Most specific prefix wins, with whole-host fallback. `/api`
redirects to `/api/`; `/api/*` strips `/api` before forwarding/serving, matching
existing `handle_path` behavior. It must not match `/apiculture`.

Routes on the same host must agree on HTTP-only versus HTTPS. Reserve panel root
and management API paths from service overrides, including panel aliases. Prefer
an existing exact Domain row, then the most specific allocated wildcard with
`subdomain`, otherwise a derived exact row. Preserve equivalent existing
bindings on no-op apply. Validate effective hosts, not just DB tuples.

### Panel and existing integrations

`panel` is the canonical public URL. A hostname means HTTPS; export retains full
URLs for existing HTTP/IP settings. `panelAliases` lists other concrete HTTPS
panel hosts. Include all in DNS planning/reference accounting even though the
protected service is not exported.

The public URL resolver currently prefers the DB setting, then wildcard-derived
URL, then `SITEY_URL`. Separately, Caddy prioritizes `SITEY_DOMAIN`. Reject
requested panel changes conflicting with `SITEY_DOMAIN`, with local recovery
instructions. Unchanged overridden config remains a no-op with a warning; a
warning must not imply an overridden requested hostname was activated.

Migration captures effective existing aliases before replacing per-domain
`siteySubdomainsEnabled` behavior. Export aliases; never disable all flags on
apply. Alias removal is explicit. Make a new origin authoritative only after
Caddy accepts it; retain the previous working route until the new endpoint
passes verification, then retire it through recorded work. Report GitHub
callback/webhook settings needing manual updates after a move.

Protected `sitey` services/routes cannot be changed, archived, or purged by
YAML. Preserve existing repo `githubMode`, rows, and hooks; never infer a
replacement mode from global App credentials. New repos need a usable
integration and access checks before deployment. Keep existing bindings when
source is unchanged; report ambiguous new bindings to duplicate repo rows rather
than guessing. Do not delete orphan repos.

## Persistence required for round trips

This feature needs a migration, not only a serializer:

- Unique `Service.configKey`, backfilled without changing numeric IDs.
- Archive metadata and saved service/route configuration. Keep IDs, env values,
  deployments, files, and analytics. Release live route bindings on archive so
  they can be deliberately reused; validate conflicts on restore.
- Declared names separate from `Service.envVars`. Backfill from existing values
  once; subsequent export reads declarations, not an implicit union with values.
  Names without values must survive export.
- Zone/provider policies, allocation ownership, panel aliases; credentials stay
  separate from these exportable records.
- Instance UUID, monotonic config revision, plans, operation status, and durable
  pending DNS/Caddy/deployment work.

All UI/CLI writes affecting planned behavior increment revision transactionally,
including env-value changes without exporting values. Read export/revision from
a consistent DB snapshot. Runtime status, credentials, sessions, timestamps, and
deployment results are excluded from the normalized YAML hash.

A semantic no-op does not increment the configuration revision. Job progress and
probe refreshes likewise do not invalidate a reviewed configuration plan.

Preserve settings outside the format instead of resetting them on update.
Migration retains unused domains, emails, aliases, and integration choices. YAML
recreates supported config; it is not a backup of secrets, hook identities,
data, or analytics.

## API tokens and transports

Add bearer auth alongside session cookies. Look up token hashes; enforce type,
expiry, revocation, and user/setup authorization. Update `lastUsedAt`. Preserve
browser origin checks.

`sitey-admin token create <name>` prints once; provide list/revoke. Tokens are
root-equivalent because Sitey controls Docker. Require verified HTTPS, except
explicitly configured loopback HTTP through an SSH tunnel for bootstrap. Never
send tokens over public HTTP or across cross-origin redirects.

Profiles use the OS user config directory: `~/.config/sitey` on Unix and
per-user application data on Windows. Enforce mode 600 or Windows ACLs limited
to the user. Tokens never appear in exports, plans, or logs.

## Planning, applying, and recovery

Separate plan and commit procedures on `settledProcedure`:

```ts
config.export(): {
  yaml: string;
  instanceId: string;
  revision: number;
  hash: string;
}

config.plan(input: {
  yaml: string;
  base?: { instanceId: string; revision: number; hash: string };
  prune?: boolean;
  force?: boolean;
}): {
  planId: string;
  instanceId: string;
  baseRevision: number;
  desiredHash: string;
  changes: Change[];
  warnings: string[];
  expiresAt: string;
}

config.apply(input: { planId: string }): {
  operationId: string;
  revision: number;
  hash: string;
  accepted: boolean;
  delivery: "pending" | "ready" | "error";
  warnings: string[];
}

config.operation(input: { operationId: string }): OperationStatus
```

These specify new APIs. Hash canonical JSON with SHA-256, versioned defaults,
sorted keys/set-like lists. Comments do not affect it. Revision detects
intervening edits even when values change back. Operations record actor,
revision, expected commits, and redacted step results.

Planning:

1. Validate identities, omissions, fields, routes, protection, and repository
   access. Return line/column information where possible.
2. Validate pull metadata. A different instance requires explicit import.
   `--force` permits a fresh plan from stale metadata against current state, not
   retargeting or bypassing safety checks.
3. Compute changes including archive/release effects. Gather full DNS snapshots
   and resolve intended deployment commits as explicit preflight, not ordinary
   DB-first reads. Report missing environment values.
4. Persist an expiring plan bound to instance, revision, desired document, prune
   choice, DNS snapshots, and commits. If DB state changed during preflight,
   return conflict instead of storing a stale plan.

Applying:

1. Verify validity and base revision atomically with the DB write. A fresh file
   without pull metadata still gets this protection through its plan.
2. Save desired config and durable operation/work records in one transaction.
   Keep enough information to stop archived containers after removing live
   routes. Never make external calls inside the transaction.
3. Workers perform DNS, Caddy projection, and deployments, recording results.
   Serialize conflicting work and guard against superseded revisions so old work
   cannot restore obsolete routes or restart archived apps.
4. Deploy new active services, reactivation, or changes to build/run fields,
   source, or branch, using resolved commits. Name/route-only changes need no
   rebuild. Inactive new services stay stopped.
5. Return acceptance separately from delivery. Provider/Caddy/build failures are
   persisted; they do not mean the DB transaction rolled back.

The in-memory queue may wake workers but cannot be the only work record. Recover
pending/interrupted tasks on startup. Use stable task IDs and reconcile Docker
state before retrying build/start/stop. Do not promise exactly-once external
effects. Applying an already consumed plan returns its original operation rather
than new work, even when later revisions exist.

Zero-config-diff pushes still report/resume unfinished reconciliation. Transient
failures retry with bounded backoff; external conflicts/permanent failures need
correction or a fresh plan. Allow explicit retry when the operation revision is
still current. Persist failure details and superseded status.

### Archive, restore, and purge

Pruning stops/removes containers, removes live routes, suppresses webhooks, and
retains the service row/ID, saved config, env values, deployment history, files,
and analytics. Restore explicitly reuses the ID and validates routes, initially
inactive; activation/deployment is explicit afterward.

Current `services.delete` removes files and DB deletion cascades to deployments.
Never reuse it for archive. Align normal UI removal with archive when this
ships. Purge is a separate explicit destructive operation outside config apply,
with its data/history scope presented to the user; it may remain deferred.

## Environment values

The website suffices initially. Later provide:

```sh
sitey env import idea-a --file .env.production
sitey env set idea-a DATABASE_URL --stdin
sitey env unset idea-a DATABASE_URL
sitey env list idea-a
```

Service arguments are config keys. Parse files as data with a documented dotenv
grammar shared with deployment/UI. Never source files or execute substitutions.
Define quoting, multiline/empty values, and duplicate-name errors. Do not
implicitly read a nearby `.env`.

Import merges supplied values, preserving unspecified ones. Unset is explicit;
show changed names only. Value writes do not modify declarations implicitly.
Missing declared values warn and block the affected deployment, while config
acceptance and unrelated services can proceed. Undeclared values warn without
deletion.

Saving values does not deploy automatically, matching today's UI. Offer
`--deploy` for one deployment after a batch or use `sitey deploy`. Blocked
deployments need explicit deploy/retry after values are supplied rather than
silently running an obsolete operation. Static builds can use env too; values
embedded in output may become public.

## DNS providers and Namecheap

Use a common command family with typed provider fields:

```sh
sitey dns-provider configure namecheap --user ubershmekel
```

Prompt for the key or use `--key-stdin`. List/status reports credential presence
only. Keep provider credentials separate from app env; `set-env namecheap-user`
obscures scope and validation. `sitey-admin` provides the same setup for
recovery. Credentials travel securely to the server during setup and never
return through read/export APIs.

Namecheap calls run on the VPS. A human enables API access and allowlists its
actual egress IPv4; verify it rather than assuming the inbound IP is also
egress. Check account eligibility and DNS delegation.

For each managed zone:

1. Plan allocation records, hosts needing exact records, and panel/alias hosts.
   Convert names relative to the zone (`@`, `*.s`, etc.).
2. Fetch `getHosts`; reject unsupported hosting/delegation. Snapshot the entire
   record set and email mode, not just records Sitey changes.
3. Skip writes when correct; otherwise show every addition/replacement,
   including conflicting A/CNAME records. Surface stale AAAA pointing elsewhere;
   require correction rather than silently deleting it or declaring readiness.
4. Serialize Sitey writes per zone and re-read before writing. If the snapshot
   differs from the reviewed plan, record conflict and require a new plan.
5. Send `setHosts` preserving unrelated records/attributes, then read back and
   verify. Fail closed if anything cannot safely round-trip.

Namecheap replaces the entire set without atomic revision checks. Locking and
re-reading cannot eliminate an external writer racing between read and write.
Document the limitation; avoid concurrent dashboard/other automation edits
during apply. See
[Namecheap setHosts documentation](https://www.namecheap.com/support/api/methods/domains-dns/set-hosts/).

Start from `e2e/remote/infra/namecheap.ts`, fixing round-trip gaps before
production: XML decoding, `EmailType`, `MXPref`, `TTL`, and supported
types/attributes. Reject unsupported data. Test escaped TXT/SPF and
forwarding/MX settings. Replacing an explicitly reviewed conflicting record is
allowed; garbage-collecting DNS is not.

Ship read-only `sitey dns check <zone>` first. Explicit diagnostics schedule
checks and report results; ordinary list/get/status stays DB-first. Manual zones
report required records and resolution without provider writes.

## The CLIs

Use **`sitey`** for remote everyday work and **`sitey-admin`** for local
bootstrap/ recovery. Never install different executables named `sitey` whose
behavior depends on PATH.

The current in-container CLI/host shim becomes `sitey-admin`: password recovery,
export, CLI installation, tokens, provider configuration, and local panel setup
through shared services, without the HTTP API. Give legacy local commands a
compatibility/deprecation path; retire their alias before installing remote
`sitey` at that path. Never overwrite an unrelated binary. A future
`sitey admin` namespace is possible; no automatic local/remote transport
guessing.

The new `cli/` workspace uses `AppRouter` types. Add `npm run sitey -- ...` for
checkout use; npm publication can follow later.

```text
sitey login <name> <url>
sitey servers
sitey pull [-o file]
sitey push <file> [--prune] [--yes] [--force] [--json] [--wait] [--timeout 300]
sitey import <file> --server <name> [--yes] [--json]
sitey status [--operation <id>] [--wait] [--timeout 300] [--json]
sitey retry <operation-id>
sitey deploy <service-key> [--wait] [--timeout 300]
sitey service restore <service-key>
sitey env import|set|unset|list <service-key> ...
sitey dns-provider configure <provider> ...
sitey dns check <zone>
```

All accept `--server`, overriding `SITEY_SERVER`, then default profile. Require
selection when ambiguous. Profiles remember instance UUIDs.

Pull writes instance UUID/revision/hash in a machine-readable YAML comment
header, without tokens/timestamps. Push refreshes it after acceptance. Missing
metadata is allowed for new files; plan binding/omission checks remain. Import
explicitly drops source binding and plans against the named target, including
matching-key updates. It transfers no data/secrets and does not enable prune. To
replace target resources, pull from that target afterward and explicitly review
pruning.

Push displays destination, diff, warnings, and effects. Interactive use
confirms; `--yes` applies that exact plan. Conflict returns an error, never a
silently replanned apply. `--force` bypasses neither plan revision checks nor
`--prune` requirements.

JSON goes to stdout; diagnostics to stderr. Noninteractive apply requires
`--yes`. Exit codes: 0 accepted (ready when waiting), 1 operational failure, 2
validation, 3 DB/external conflict, 4 timeout. Async results include operation
ID/delivery state; acceptance is not proof of launch.

## Status and launch verification

Status reads cached DB state with freshness timestamps and deduplicated
background probes, never synchronous external calls in ordinary reads. Wait
polls with backoff and finite timeout, requesting refreshes as needed.

Report revision, intended commit, actual deployment, step errors, DNS (including
IPv6 conflicts), TLS validity/expiry for HTTPS, and HTTP probe status/time for
the configured route path. HTTP-only routes mark TLS not applicable.

Ready requires intended deployment, active routing, appropriate DNS/TLS, and an
acceptable HTTP result. Version 1 landing-page verification expects a 2xx result
after at most five redirects within the configured host, permitting
HTTP-to-HTTPS upgrades but never HTTPS downgrades. Other redirects are reported
for inspection. HTTP 200 alone is insufficient: today's pending page can
return 200. An unrelated site returning 200 is not success. For apps whose
normal response is 401 or another non-2xx status, report deployment success and
the raw HTTP result separately; do not report landing-page readiness or invent
an application health contract. Custom health-check policies can follow later.
Probing cannot prove correctness.

## Human prerequisites and flows

### New VPS (once)

1. A human provisions the VPS and runs the installer.
2. Establish the final panel hostname before remote authentication. Initially,
   create DNS manually and use new local
   `sitey-admin panel set https://sitey.andluck.com`. When provider automation
   ships, a local flow can configure credentials/zone over SSH, review DNS, and
   provision the host without an API token or working HTTPS.
3. Verify HTTPS and resolve `SITEY_DOMAIN` conflicts locally. Earlier browser
   setup uses an SSH loopback tunnel to HTTP, not public HTTP for credentials.
4. A human logs in, creates/connects the GitHub App, completes consent, installs
   it on the owning account, and grants access to `ubershmekel/myswe`.
   Installation and OAuth authorization are distinct. Use the final URL for
   callbacks/webhooks. Config apply cannot complete these account/browser steps.
   See
   [GitHub installation documentation](https://docs.github.com/en/enterprise-cloud%40latest/apps/using-github-apps/installing-a-github-app-from-a-third-party).
5. `ssh vps sitey-admin token create home-pc`, then
   `sitey login andluck https://sitey.andluck.com`, entering the token locally.
6. For Namecheap, enable API access/allowlist egress IP manually, then
   `sitey dns-provider configure namecheap --user ubershmekel` if needed. Verify
   repository access/provider readiness and report missing prerequisites.
7. Pull the complete initial config, edit policies/allocations/services, plan,
   and push. Never start with an incomplete file against a populated VPS.

### New landing page

The private repo holds `landings/idea-a/`, `landings/idea-b/`, and
`sitey/andluck.yaml`. Each service clones to `/data/services/<numeric-id>/repo`,
fine for a handful of pages.

```sh
# Build and push page content to GitHub before planning deployment.
sitey pull -o sitey/andluck.yaml
# Add a complete service with a new key and concrete route; commit/push config.
sitey push sitey/andluck.yaml --yes --json --wait --timeout 300
```

Planning resolves the commit. Webhooks may already deploy content updates;
deduplicate equivalent work and serialize per service. Newer work superseding
the target is reported as superseded, not ready for a different commit. After
timeout, inspect with `sitey status --operation <id> --wait`.

### Allocate, rename, or retire

Add `"*.redditp.com": {}` under `domains` to reserve without routes. Allocate
apex separately if wanted. Add its zone under `dns` for automation; policy alone
creates no apex A record.

Change `services.idea-a.name` to rename without changing ID/data/analytics.
Pause with `active: false`. Archive by removing the entry and using `--prune`.
Restore with `sitey service restore idea-a`, initially inactive; pull, review
routes, then explicitly activate/deploy.

### Move a panel hostname

Provision/verify the new host before removing the old alias. Check environment,
GitHub callback/webhook URLs, and CLI profiles before repointing other DNS. When
retaining `*.s.andluck.com` on the old VPS while moving `*.andluck.com`,
preserve and verify nested/exact records and delegations; a wildcard alone does
not prove all descendants resolve as intended.

## Team mode (later)

A config repo can trigger the same plan/apply and durable worker. Bind each
instance to its file and repository installation. Validation errors leave DB
unchanged; external failures remain partial/pending. Post status for the
intended config/commit and make file-managed UI fields read-only. Define prune
policy before webhook-triggered archives. Never promise atomic DNS/build
rollback.

## Build order and acceptance tests

1. **Persistence/export.** Backfill keys, declarations, allocations, policies,
   aliases, instance/revision metadata; update schema/migration SQL. Test
   duplicate names, unused/nested wildcards, emails, aliases, repo bindings,
   missing env values, and semantic export/apply no-op fixtures.
2. **Auth/local CLI.** Tokens, `sitey-admin`, compatibility, secure bootstrap.
   Test expiry/revocation/type/unknown tokens, HTTPS/loopback rules, instance
   binding, and Windows profile permissions.
3. **Schema/plans.** Test truncated YAML, duplicate keys, omission/prune,
   protection, routes/schemes, stale metadata, import, hashes, and edits during
   preflight.
4. **Remote reads/plans.** Login, profiles, pull, dry-run push, cached status.
   Test JSON/exit codes and comment metadata round-trips.
5. **Apply/recovery.** Durable work, archive/restore, revision-bound apply,
   deployment reconciliation, panel transitions, waits. Test rename preserves
   ID/files/history/ analytics; prune never calls destructive delete; restore
   preserves ID; duplicate apply; crashes after commit/during external steps;
   no-diff retry; concurrent UI edits; inactive/superseded work.
6. **Optional env CLI.** Merge import, stdin, explicit unset/deploy, shared
   grammar. Test multiline/quoted/empty values, duplicates, unspecified-value
   retention, secret redaction, missing-value blocking.
7. **Namecheap.** Diagnostics and round-trip fixtures before writes. Test
   record/ email/TXT preservation, unknown attributes, external conflicts,
   nested zones/ wildcards, panel DNS, IPv6 conflicts, verification, recovery.
8. **Verification/agent guide.** Test pending-page 200 is not readiness,
   intended commits, freshness, TLS failures, HTTP-only routes, timeout/resume,
   and human prerequisites. Document common workflows.

Use manual DNS after phase 5; env values may stay in the website. Enable
Namecheap writes only after preservation/conflict tests pass. This document
change does not implement the proposed commands or schema.
