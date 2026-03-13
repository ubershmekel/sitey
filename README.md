# Sitey

The easiest way to auto-deploy from GitHub to your server. Designed for vibe
coders, coders, and kids who can't read good.

## Install with one line (tested on Hetzner Ubuntu VPS)

SSH into your server and run:

```bash
curl -fsSL https://raw.githubusercontent.com/ubershmekel/sitey/main/deploy/install-ubuntu.sh | bash
```

This takes 1-2 minutes to install Docker, install Sitey to `/opt/sitey`, start
the stack, then print:

- `URL: http://<your-server-ip>`
- `Admin password: <one-time-override-password>`

Works on standard Ubuntu VPS hosts (for example: Hetzner, DigitalOcean, Linode).

You'll get a **self-hosted, domain-first PaaS.** Deploy Node.js apps from GitHub
to your own VM with automatic HTTPS.

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

## Adding a domain + project

1. Open Sitey in your browser and log in.
2. Click **+ Add domain** → enter your app's hostname (e.g. `myapp.com`). If
   you've set up a wildcard DNS record (`*.myapp.com → your IP`), new projects
   will automatically get a random subdomain (e.g. `happy-fox-3k2.myapp.com`) —
   see [Enabling HTTPS](docs/ops.md#enabling-https).
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

## Operations

For manual install, updating, HTTPS setup, data paths, account recovery, and
other operational tasks, see [docs/ops.md](docs/ops.md).

## Development

See [docs/development.md](docs/development.md) for local setup, DB scripts, and
how to keep migrations in sync with `schema.prisma`.
