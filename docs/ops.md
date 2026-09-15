# Operations Guide

## Default paths

A standard install (via the one-liner or manual steps) puts everything under
`/opt/sitey`:

```
/opt/sitey/                # git clone root
├── deploy/
│   ├── docker-compose.yml
│   └── data/              # DATA_ROOT (default ./data)
│       ├── sitey.db       # SQLite database
│       └── services/
│           └── <serviceId>/
│               ├── repo/  # git checkout
│               └── logs/
│                   └── <deploymentId>.log
```

To use a different host path, set `DATA_ROOT` in a `.env` file next to
`docker-compose.yml`:

```
DATA_ROOT=/opt/sitey/data
```

---

## Prerequisites

- A Linux VM (Ubuntu 22.04+ recommended) with a public IP
- Docker Engine 24+ and Docker Compose v2
- Ports 80 and 443 open in the firewall

---

## Manual install (instead of the one-liner)

```bash
# 1. Install Docker (if not already installed)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker

# 2. Clone Sitey
git clone https://github.com/ubershmekel/sitey /opt/sitey
cd /opt/sitey/deploy

# 3. Start
docker compose up -d --build

# 4. Generate your login credentials
docker compose exec sitey-api npm run bootstrap:generate-password
```

This prints a one-time override password. Open the address shown in the logs, go
to the login page, enter **your email** and that password — Sitey creates your
account and prompts you to set a real password. The override password is burned
after first use.

---

## Updating

### From the UI (recommended)

Open **Settings → Update Sitey** and click **Update Sitey**. The button triggers
the `sitey-updater` sidecar container, which runs three steps and streams the
output live:

1. Read the update script into memory (before pulling, so it references the
   current generation's filename — see "How the updater sidecar works" below)
2. `git pull` — fetches the latest code
3. `docker compose build` — rebuilds images for services defined in
   docker-compose.yml (except the updater, so it can keep running)
4. `docker compose up -d` — restarts services with the new images

The page will briefly disconnect when the API container restarts. Reload once it
comes back.

> **Note:** `sitey-updater` must be running. If you don't see it
> (`docker compose ps`), start it with `docker compose up -d sitey-updater`.

### From the command line

```bash
cd /opt/sitey/deploy
git pull
docker compose up -d --build
```

Migrations run automatically on startup. If the API fails to start after an
update (check `docker compose logs sitey-api`), the schema may have changed in a
way that requires a fresh DB — see **Nuking data** below.

### How the updater sidecar works

`sitey-updater` is a dormant container (`sleep infinity`) built from
`deploy/updater/Dockerfile`. It has three mounts:

- `/var/run/docker.sock` — so it can run `docker compose` commands
- `/sitey-root` — the repo root (i.e. `/opt/sitey`), for `git pull` and to read
  `update-docker.sh` at exec time
- `/data` — shared data volume, used to write `.update.log` (survives API
  restart)

When you click **Update Sitey**, `sitey-api` execs into the updater container
and runs a single shell command that:

1. Reads `update-docker.sh` into a shell variable (`$UPDATE_SCRIPT`)
2. Runs `git pull`
3. Evals `$UPDATE_SCRIPT` from memory

The script is read **before** `git pull` so it references the current
generation's filename, not the incoming one. This means the update script can be
safely renamed — just update the path in `system.ts` in the same commit. After
`docker compose up -d` restarts the API, the new `system.ts` takes over with
whatever the new filename is. Each deployed generation only ever talks to
itself.

Because the script is read from the mount rather than baked into the image, you
never need to rebuild the updater image just to change the update logic.

---

## The `sitey` CLI

`install-ubuntu.sh` installs a `sitey` command on the host. It runs
`node src/cli.ts` inside the `sitey-api` container, so it works over SSH too
(`ssh my-vps sitey export`).

| Command                                | When to use                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------- |
| `generate-password`                    | Generate a one-time override password usable on any account at the login page |
| `export`                               | Print the server's configuration as deterministic YAML                        |
| `token create <name> [--user <email>]` | Create an API token for `siteyctl` (printed once, on stdout)                  |
| `token list`                           | List API tokens and when they were last used                                  |
| `token revoke <name>`                  | Delete an API token                                                           |
| `install-cli`                          | (host only) Install or reinstall `/usr/local/bin/sitey`                       |
| `help`                                 | List commands                                                                 |

API tokens are **root-equivalent on the VPS**: Sitey controls the Docker socket.
Revoke any token you no longer use.

## `siteyctl`: the remote CLI

`siteyctl` drives a Sitey server from another machine over HTTPS with an API
token: create services, add routes, set env vars, deploy, check that a site is
live, and export the config. Design:
[docs/design/remote-cli.md](design/remote-cli.md). From a checkout:

```bash
ssh my-vps sitey token create home-pc | npm run siteyctl -- login my-vps https://sitey.example.com
npm run siteyctl -- --help
```

`-o` paths are resolved against the directory you ran `npm run` from.

Installs from before the CLI existed: update Sitey, then run once on the host:

```bash
sh /opt/sitey/deploy/sitey install-cli
```

`install-cli` is handled by the host-side script
[`deploy/sitey`](../deploy/sitey) rather than the container, because the
container can't write to the host's `/usr/local/bin`. The installed command is a
two-line wrapper around that script, so CLI changes arrive with `git pull`.

Without the CLI installed, the same commands run via compose:

```bash
cd /opt/sitey/deploy
docker compose exec sitey-api npm run cli -- export
docker compose exec sitey-api npm run bootstrap:generate-password
```

---

## Locked out?

### Password reset

If you've forgotten your password or the account is in a bad state:

```bash
sitey generate-password
```

This generates an override password and prints it to stdout. Use it with your
email on the login page, then set a new password when prompted.

### Public Sitey URL change

If login stopped working immediately after changing **Settings → Public Sitey
URL**, Caddy and the API may still be using the previous management hostname.
Current Sitey versions refresh Caddy automatically when this setting changes.
For an older version, or to recover from a failed refresh, restart the API:

```bash
cd /opt/sitey/deploy
docker compose restart sitey-api
```

The API refreshes Caddy during startup. Then open the newly configured URL and
sign in again; session cookies do not transfer between hostnames.

If `SITEY_DOMAIN` is set in `deploy/.env`, it takes precedence over the Public
Sitey URL for the management hostname. Update or remove that variable, then run
`docker compose up -d sitey-api` so the container receives the changed
environment.

---

## Enabling HTTPS

By default Sitey serves plain HTTP on port 80 (no domain required to get
started). To enable HTTPS:

1. Point a DNS `A` record **and** a wildcard `A` record at your VM's IP:

   ```
   your.domain.com      A  <your VM IP>
   *.your.domain.com    A  <your VM IP>
   ```

   The wildcard record is optional but **highly recommended** — it lets Sitey
   auto-assign a random subdomain to every new service (e.g.
   `happy-fox-3k2.your.domain.com`), exactly like Netlify or Vercel, with no
   extra DNS steps per service. Without it you must manually add a route or DNS
   record for each new service want.

2. Edit `deploy/caddy/Caddyfile` — replace the `:80` block with:

```caddyfile
your.domain.com {
    handle /api/* { reverse_proxy sitey-api:3001 }
    handle     { reverse_proxy sitey-web:80    }
}
```

3. Restart Caddy: `docker compose restart caddy`

Caddy will automatically obtain a Let's Encrypt certificate.

---

## DANGER: Wipe the data (fresh start)

Wipes all users, services, domains, deployments, and the generated admin
password. Deployed app containers are left running.

```bash
cd /opt/sitey/deploy
docker compose down
rm -f data/sitey.db
docker compose up -d --build
docker compose logs sitey-api | grep password   # new password printed on first boot
```

Optional cleanup for completeness — remove deployed app containers:

```bash
docker ps -a --filter label=caddy               # list managed app containers
docker rm -f <container-id>                     # remove as needed
```

## GitHub integration

### GitHub App (recommended)

1. Create a GitHub App at `https://github.com/settings/apps/new`:
   - Webhook URL: `http://<your-server>/api/webhook/github`
   - Webhook secret: any strong random string
   - Permissions: Repository → Contents (read), Metadata (read)
   - Subscribe to: `Push` events
2. In Sitey → Settings → **GitHub App integration**, paste:
   - App ID
   - Private key (PEM)
   - Webhook secret
3. Install the App on your repos.
4. On the service, set `GitHub mode: app` and paste the Installation ID.

### Webhook

1. On the service detail page, find the **GitHub Webhook Setup** card.
2. In your GitHub repo → Settings → Webhooks → Add webhook:
   - **Payload URL**: paste from the card
   - **Content type**: `application/json`
   - **Secret**: paste from the card
   - **Events**: `Just the push event`
3. Push to the configured branch → Sitey auto-deploys.

---

## Deployment flow

```
GitHub push
    └─▶ /api/webhook/github  (signature verified)
         └─▶ DB: create Deployment (queued)
              └─▶ DeploymentQueue
                   ├─ git clone / pull → /data/services/:id/repo
                   ├─ docker build -t sitey/:id:<sha>
                   ├─ docker run (with Caddy labels, on sitey-public network)
                   └─ DB: update status → success / failed
```

Logs are written to `/data/services/:id/logs/:deploymentId.log` and viewable in
the UI.

---

**Constraints:** Your app must listen on `process.env.PORT` and the entry point
must be `server.js` (or have a `start` script in package.json). For anything
else, provide your own `Dockerfile`.

---

## Environment variables for deployed apps

Set env vars on the service detail page (Settings tab, coming soon) or via the
API. They are injected as container env vars at deploy time.

`PORT` is always injected automatically and set to the configured container
port.
