# Sitey

**Self-hosted, domain-first PaaS.** Deploy Node.js apps from GitHub to your own VM with automatic HTTPS via Caddy + Let's Encrypt.

> **Status:** MVP scaffold — core plumbing is done; polish and edge-case hardening ongoing.

---

## Stack

| Layer | Technology |
|-------|------------|
| API | TypeScript + Fastify + tRPC v11 |
| DB | SQLite + Prisma |
| Frontend | Vue 3 + Pinia (Vite) |
| Reverse proxy | Caddy (caddy-docker-proxy) + Let's Encrypt |
| Deployments | Docker-in-Docker via socket mount |

---

## Prerequisites

- A Linux VM (Ubuntu 22.04+ recommended) with a public IP
- Docker Engine 24+ and Docker Compose v2
- Your domain's DNS `A` record pointing to the VM IP
- Ports 80 and 443 open in the firewall

---

## Quick Start (fresh VM)

```bash
# 1. Install Docker (if not already installed)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker

# 2. Clone Sitey
git clone https://github.com/yourorg/sitey.git /opt/sitey
cd /opt/sitey/deploy

# 3. Configure
cp .env.example .env
nano .env          # set SITEY_DOMAIN, ACME_EMAIL, JWT_SECRET

# 4. Create data directory
mkdir -p data

# 5. Start
docker compose up -d --build

# 6. View the generated admin password (only printed on first boot)
docker compose logs sitey-api | grep -A 8 "FIRST RUN"
```

Open `https://<SITEY_DOMAIN>` in your browser. Sign in with the printed credentials. **You will be forced to change your password on first login.**

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

Map this to a safer host path by setting `DATA_ROOT` in `.env`:

```
DATA_ROOT=/opt/sitey/data
```

---

## Viewing the initial admin password

```bash
docker compose logs sitey-api | grep -A 10 "FIRST RUN"
```

The password is printed **once** at first boot. If you missed it, reset it (see below).

---

## Resetting the admin password (secure)

Run this on the host — it prints a new random password and marks the account for forced change:

```bash
docker compose exec sitey-api node dist/services/bootstrap.js reset
```

The new password is printed in the terminal (never stored in plaintext).

---

## Adding a domain + project

1. Open `https://<SITEY_DOMAIN>` and log in.
2. Click **+ Add domain** → enter your app's hostname (e.g. `myapp.com`) and your Let's Encrypt email.
3. On the domain page, click **+ Add project**:
   - Enter repo owner/name (e.g. `acme/my-node-app`) and branch.
   - Choose **Build mode**: `auto` generates a Dockerfile for Node.js apps; `dockerfile` uses your repo's `Dockerfile`.
   - Set **Container port** (default 3000).
   - Choose **GitHub integration mode** (see below).
4. Click **Create project**.
5. Click **▶ Deploy** to trigger your first deployment.

Caddy will automatically obtain a Let's Encrypt certificate and route traffic when the container starts.

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
   - Webhook URL: `https://<SITEY_DOMAIN>/webhook/github/<projectId>`
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

Logs are written to `/data/projects/:id/logs/:deploymentId.log` and viewable in the UI.

---

## Default Node.js Dockerfile (auto mode)

When no `Dockerfile` is found, Sitey generates:

```dockerfile
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build --if-present

FROM node:20-alpine
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app .
ENV NODE_ENV=production
ENV PORT=<containerPort>
EXPOSE <containerPort>
CMD ["node", "server.js"]
```

**Constraints:** Your app must listen on `process.env.PORT` and the entry point must be `server.js` (or have a `start` script in package.json). For anything else, provide your own `Dockerfile`.

---

## Environment variables for deployed apps

Set env vars on the project detail page (Settings tab, coming soon) or via the API. They are injected as container env vars at deploy time.

`PORT` is always injected automatically and set to the configured container port.

---

## Development

```bash
# Install dependencies
cd server && npm install
cd ../web  && npm install

# Start Postgres (SQLite, no extra setup needed)
cd server
cp .env.example .env   # set DATABASE_URL=file:./dev.db
npm run db:push        # create tables
npm run dev            # starts on :3001

# In another terminal
cd web
npm run dev            # starts on :5173 (proxies /trpc → :3001)
```

---

## Architecture notes

- **Single-host only.** The deployment queue is in-memory; multi-instance is not supported without Redis.
- **Docker socket.** The `sitey-api` container has `rwx` access to the Docker daemon. Treat it as root-equivalent.
- **Secrets.** JWT secret and passwords are never stored in plaintext. GitHub App private key is stored as-is in SQLite for now — encrypt at rest if your threat model requires it.
- **ACME email.** Set once via `ACME_EMAIL` in `.env` — Caddy uses it globally for all domains it serves (management domain + user app domains). Individual domain emails stored in the DB are currently informational only.

---

## Roadmap

- [ ] Environment variable editor in UI
- [ ] Multi-project per domain via subdomains (UI support)
- [ ] GitHub App OAuth flow (auto-select repos)
- [ ] Deployment rollback
- [ ] Real-time log streaming (SSE/WebSocket)
- [ ] Resource limits (CPU/memory) on project containers
- [ ] Teams / multi-user support
