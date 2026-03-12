# Sitey

The easy way to auto-deploy from GitHub to your server.

## Install with one line (tested on Hetzner Ubuntu VPS)

SSH into your server and run:

```bash
curl -fsSL https://raw.githubusercontent.com/ubershmekel/sitey/main/deploy/install-ubuntu.sh | bash
```

This takes 1-2 minutes to install Docker, install Sitey to `/opt/sitey`, starts
the stack, then prints:

- `URL: http://<your-server-ip>`
- `Admin password: <one-time-override-password>`

Works on standard Ubuntu VPS hosts (for example: Hetzner, DigitalOcean, Linode).

You'll get a **self-hosted, domain-first PaaS.** Deploy Node.js apps from GitHub
to your own VM with automatic HTTPS via Caddy + Let's Encrypt.

---

## Stack

| Layer         | Technology                                 |
| ------------- | ------------------------------------------ |
| API           | TypeScript + Fastify + tRPC v11            |
| DB            | SQLite + Prisma                            |
| Frontend      | Vue 3 + Pinia (Vite)                       |
| Reverse proxy | Caddy (caddy-docker-proxy) + Let's Encrypt |
| Deployments   | Docker-in-Docker via socket mount          |

---

## Prerequisites

- A Linux VM (Ubuntu 22.04+ recommended) with a public IP
- Docker Engine 24+ and Docker Compose v2
- Ports 80 and 443 open in the firewall

---

## Quick Start (fresh VM)

### Manual steps

```bash
# 1. Install Docker (if not already installed)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker

# 2. Clone Sitey
git clone https://github.com/ubershmekel/sitey
cd sitey/deploy

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
cd sitey/deploy
git pull
docker compose up -d --build
```

Migrations run automatically on startup. If the API fails to start after an
update (check `docker compose logs sitey-api`), the schema may have changed in a
way that requires a fresh DB — see **Nuking data** below.

---

## DANGER Wipe the data (fresh start)

Wipes all users, projects, domains, deployments, and the generated admin
password. Deployed app containers are left running.

```bash
cd sitey/deploy
docker compose down
rm -f data/sitey.db
docker compose up -d --build
docker compose logs sitey-api | grep password   # new password printed on first boot
```

Optional cleanup for a completeness - remove deployed app containers:

```bash
docker ps -a --filter label=caddy               # list managed app containers
docker rm -f <container-id>                     # remove as needed
```

---

## Where data lives

All persistent state is under the `data/` directory inside `deploy/`:

```
deploy/data/
├── sitey.db               # SQLite database
└── projects/
    └── <projectId>/
        ├── repo/          # git checkout
        └── logs/
            └── <deploymentId>.log
```

To use a different host path, set `DATA_ROOT` in a `.env` file next to
`docker-compose.yml`:

```
DATA_ROOT=/opt/sitey/data
```

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

## Adding a domain + project

1. Open Sitey in your browser and log in.
2. Click **+ Add domain** → enter your app's hostname (e.g. `myapp.com`). If
   you've set up a wildcard DNS record (`*.myapp.com → your IP`), new projects
   will automatically get a random subdomain (e.g. `happy-fox-3k2.myapp.com`) —
   see [Enabling HTTPS](#enabling-https).
3. On the domain page, click **+ Add project**:
   - Enter repo owner/name (e.g. `acme/my-node-app`) and branch.
   - Choose **Build mode**: `auto` generates a Dockerfile for Node.js apps;
     `dockerfile` uses your repo's `Dockerfile`.
   - Set **Container port** (default 3000).
   - Choose **GitHub integration mode** (see below).
4. Click **Create project**.
5. Click **▶ Deploy** to trigger your first deployment.

Caddy will automatically obtain a Let's Encrypt certificate and route traffic
when the container starts.

---

## GitHub integration

### Option A — Webhook (simpler)

1. On the project detail page, find the **GitHub Webhook Setup** card.
2. In your GitHub repo → Settings → Webhooks → Add webhook:
   - **Payload URL**: paste from the card
   - **Content type**: `application/json`
   - **Secret**: paste from the card
   - **Events**: `Just the push event`
3. Push to the configured branch → Sitey auto-deploys.

### Option B — GitHub App

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

---

## Development

See [docs/development.md](docs/development.md) for local setup, DB scripts, and
how to keep migrations in sync with `schema.prisma`.

---

## Roadmap

- [ ] Environment variable editor in UI
- [ ] Multi-project per domain via subdomains (UI support)
- [ ] GitHub App OAuth flow (auto-select repos)
- [ ] Deployment rollback
- [ ] Real-time log streaming (SSE/WebSocket)
- [ ] Resource limits (CPU/memory) on project containers
- [ ] Teams / multi-user support
