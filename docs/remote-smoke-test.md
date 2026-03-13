# Remote reset + smoke test

This guide assumes:

- Sitey is installed on the remote host.
- You can SSH as root (or a user that can run Docker).
- DNS already points to your server, for example:
  - `sitey.example.com -> <your-server-ip>`
  - `*.sitey.example.com -> <your-server-ip>`

## 1) Reset remote instance

One-time setup from your local repo:

```bash
cp scripts/testing/reset-remote.env.example scripts/testing/reset-remote.env
```

PowerShell alternative:

```powershell
Copy-Item scripts/testing/reset-remote.env.example scripts/testing/reset-remote.env
```

Edit `scripts/testing/reset-remote.env` and set:

- `SSH_TARGET` (example: `root@12.34.56.78`)
- `SITEY_URL` (example: `https://sitey.example.com`)
- `REMOTE_DEPLOY_DIR` (usually `/opt/sitey/deploy`)
- `REFRESH_MODE`:
  - `pull` (recommended): `git pull --ff-only` before reset
  - `installer`: runs `install-ubuntu.sh` first
  - `none`: no code refresh

Then run reset with one command:

```bash
npm run test:reset-remote
```

You can run the same command from your IDE package scripts UI as a one-click
action.

Expected output includes:

- `----- SITEY RESET COMPLETE -----`
- `URL: https://sitey.example.com`
- `Password: <one-time-password>`

## 2) Run the browser smoke test

Use a fresh incognito window so session state does not leak between runs.

1. Open `https://sitey.example.com/login`.
2. Sign in with your email + the printed one-time password.
3. Set a permanent password when prompted.
4. Click `+ Add domain` and add `sitey.example.com`.
5. Open the new domain page and verify TLS status appears (not `error`).
6. Click `+ Add project`.
7. Fill a test repo (`owner/name`, branch, build mode, container port), then
   create.
8. Click `Deploy` and wait for status `success`.
9. Open the project route and verify it serves over `https://`.

## 3) Screenshot checkpoints (recommended)

Take screenshots at:

1. Login page with reset timestamp visible in browser tab/history.
2. Domain page showing TLS status.
3. Project page after create.
4. Deployment log/status showing `success`.
5. Live project URL loaded over `https://`.

Store them in a dated folder (example: `artifacts/smoke/2026-03-13/`).

## 4) Fast troubleshooting

- If password parsing fails, run on server:
  - `cd /opt/sitey/deploy`
  - `docker compose exec -T sitey-api npm run -s bootstrap:init`
- If HTTPS does not issue:
  - Confirm both A records point to the server IP.
  - Confirm ports 80/443 are open.
  - Check: `docker compose logs caddy --tail=200`
- If deploy fails:
  - Check: `docker compose logs sitey-api --tail=200`
  - Open deployment logs in Sitey UI for the specific project.
