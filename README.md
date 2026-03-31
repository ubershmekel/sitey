# Sitey

The easiest way to auto-deploy from GitHub to your server. Designed for vibe
coders, coders, and kids who can't read good.

You'll get a dashboard with a list of your services, domains, deployments, and
an easy way to control everything.

## How to self-host

New to self-hosting? Start with the
[Guide to self-hosting](docs/guides/README.md) for a step-by-step path from
server setup (on Hetzner, or AWS EC2) to live DNS (on Namecheap, Route 53, or
GoDaddy).

## Install Sitey with one line

If you have a domain and server ready, just SSH into your server and run:

```bash
curl -fsSL https://raw.githubusercontent.com/ubershmekel/sitey/main/deploy/install-ubuntu.sh | bash
```

This takes 1-2 minutes to install Docker, install Sitey to `/opt/sitey`, start
the stack, then print:

- `URL: http://<your-server-ip>`
- `Admin password: <one-time-override-password>`

Works on standard Ubuntu VPS hosts (for example: Hetzner, DigitalOcean, Linode).

You'll get a **self-hosted, domain-first PaaS.** Deploy Node.js apps (or any
docker really) from GitHub to your own VM with automatic HTTPS.

---

## Stack

| Layer         | Technology                      |
| ------------- | ------------------------------- |
| API           | TypeScript + Fastify + tRPC v11 |
| DB            | SQLite + Prisma                 |
| Frontend      | Vue 3 + Pinia + Vite            |
| Reverse proxy | Caddy + Let's Encrypt           |
| Deployments   | Docker + Dockerode              |

---

## Adding a domain + service

1. Open Sitey in your browser and log in.
2. Click **+ Add domain** → enter your app's hostname (e.g. `myapp.com`). If
   you've set up a wildcard DNS record (`*.myapp.com → your IP`), new services
   will automatically get a random subdomain (e.g. `happy-fox-3k2.myapp.com`) —
   see [Enabling HTTPS](docs/ops.md#enabling-https).
3. On the domain page, click **+ Add service**:
   - Enter repo owner/name (e.g. `acme/my-node-app`) and branch.
   - Choose **Build mode**: `auto` generates a Dockerfile for Node.js apps;
     `dockerfile` uses your repo's `Dockerfile`.
   - Set **Container port** (default 3000).
   - Choose **GitHub integration mode** (see below).
4. Click **Create service**.
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
