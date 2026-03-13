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
│       └── projects/
│           └── <projectId>/
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
docker compose exec sitey-api npm run -s bootstrap:init
```

This prints a one-time override password. Open the address shown in the logs, go
to the login page, enter **your email** and that password — Sitey creates your
account and prompts you to set a real password. The override password is burned
after first use.

---

## Updating

```bash
cd /opt/sitey/deploy
git pull
docker compose up -d --build
```

Migrations run automatically on startup. If the API fails to start after an
update (check `docker compose logs sitey-api`), the schema may have changed in a
way that requires a fresh DB — see **Nuking data** below.

---

## CLI account commands

Both commands run against the live container and print credentials to stdout.

| Command | When to use                                                                   |
| ------- | ----------------------------------------------------------------------------- |
| `init`  | Generate a one-time override password usable on any account at the login page |
| `reset` | Locked out — generates a new random password for the first user               |

```bash
# Initial setup (before setup wizard is completed)
docker compose exec sitey-api npm run -s bootstrap:init

# Skeleton key password reset (after setup is complete)
docker compose exec sitey-api npm run -s bootstrap:reset
```

These scripts auto-detect whether the container has built JS (`dist/`) or source
TS (`src/`) and run the right entrypoint.

---

## Locked out?

If you've forgotten your password or the account is in a bad state:

```bash
cd /opt/sitey/deploy
docker compose exec sitey-api npm run -s bootstrap:reset
```

This generates a new random password for the first user account and prints it to
stdout. Use it to log in, then set a new password when prompted.

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
   auto-assign a random subdomain to every new project (e.g.
   `happy-fox-3k2.your.domain.com`), exactly like Netlify or Vercel, with no
   extra DNS steps per project. Without it you must manually add a route or DNS
   record for each new project want.

2. Edit `deploy/caddy/Caddyfile` — replace the `:80` block with:

```caddyfile
your.domain.com {
    @api path /trpc* /webhook* /health*
    handle @api { reverse_proxy sitey-api:3001 }
    handle     { reverse_proxy sitey-web:80    }
}
```

3. Restart Caddy: `docker compose restart caddy`

Caddy will automatically obtain a Let's Encrypt certificate.

---

## DANGER: Wipe the data (fresh start)

Wipes all users, projects, domains, deployments, and the generated admin
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
   - Webhook URL: `http://<your-server>/webhook/github/<projectId>`
   - Webhook secret: any strong random string
   - Permissions: Repository → Contents (read), Metadata (read)
   - Subscribe to: `Push` events
2. In Sitey → Settings → **GitHub App integration**, paste:
   - App ID
   - Private key (PEM)
   - Webhook secret
3. Install the App on your repos.
4. On the project, set `GitHub mode: app` and paste the Installation ID.

### Webhook

1. On the project detail page, find the **GitHub Webhook Setup** card.
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
    └─▶ /webhook/github/:projectId  (signature verified)
         └─▶ DB: create Deployment (queued)
              └─▶ DeploymentQueue
                   ├─ git clone / pull → /data/projects/:id/repo
                   ├─ docker build -t sitey/:id:<sha>
                   ├─ docker run (with Caddy labels, on sitey-public network)
                   └─ DB: update status → success / failed
```

Logs are written to `/data/projects/:id/logs/:deploymentId.log` and viewable in
the UI.

---

**Constraints:** Your app must listen on `process.env.PORT` and the entry point
must be `server.js` (or have a `start` script in package.json). For anything
else, provide your own `Dockerfile`.

---

## Environment variables for deployed apps

Set env vars on the project detail page (Settings tab, coming soon) or via the
API. They are injected as container env vars at deploy time.

`PORT` is always injected automatically and set to the configured container
port.
