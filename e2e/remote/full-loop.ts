/**
 * Full-loop end-to-end test:
 *   1. Provision a Hetzner server
 *   2. Configure Namecheap DNS (wildcard A record)
 *   3. Install Sitey on the server (main-branch or worktree mode)
 *   4. Run Playwright tests against the live instance
 *   5. Tear down the server (always, even on failure)
 *
 * Config: e2e/remote/full-loop.env  (copy from full-loop.env.example)
 * Run:    npm run test:e2e-cloud:main-branch   pull from origin/main (installer path)
 *         npm run test:e2e-cloud:worktree       upload local worktree to server
 */

import { spawn } from "node:child_process";
import net from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, deleteServer } from "./infra/hetzner.ts";
import { setWildcardRecord, deleteWildcardRecord } from "./infra/namecheap.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const WORKTREE_MODE = process.argv.includes("--worktree");

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");
const envPath = resolve("e2e/remote/full-loop.env");

if (!existsSync(envPath)) {
  console.error("Missing e2e/remote/full-loop.env");
  console.error("Copy e2e/remote/full-loop.env.example and fill values.");
  process.exit(1);
}

const envFile = readFileSync(envPath, "utf8");
const config: Record<string, string> = {};
for (const rawLine of envFile.split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) continue;
  const idx = line.indexOf("=");
  if (idx <= 0) continue;
  config[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
}

const REQUIRED = [
  "HCLOUD_TOKEN",
  "NAMECHEAP_API_KEY",
  "NAMECHEAP_API_USER",
  "NAMECHEAP_CLIENT_IP",
  "DOMAIN",
  "EMAIL",
  "HETZNER_SSH_KEY",
  "SSH_PRIVATE_KEY_PATH",
] as const;

for (const key of REQUIRED) {
  if (!config[key]) {
    console.error(`Missing required config key: ${key}`);
    process.exit(1);
  }
}

// Parse DOMAIN=*.test.tagsyo.com into parts needed by the Namecheap API.
const wildcardDomain = config.DOMAIN; // e.g. *.test.tagsyo.com
const domainBare = wildcardDomain.replace(/^\*\./, ""); // test.tagsyo.com
const domainParts = domainBare.split(".");
if (domainParts.length < 3) {
  console.error(
    `DOMAIN must be a wildcard like *.sub.example.com, got: ${wildcardDomain}`,
  );
  process.exit(1);
}
const tld = domainParts[domainParts.length - 1];
const sld = domainParts[domainParts.length - 2];
const subdomainBase = domainParts.slice(0, -2).join(".");

// Append a short random suffix so each run requests a TLS cert for a hostname
// Let's Encrypt has never seen — avoids the "Too Many Failed Authorizations"
// rate limit that builds up when tests are run repeatedly against the same hostname.
const runSuffix = Date.now().toString(36).slice(-5);
const subdomain = `${subdomainBase}-${runSuffix}`;
const wildcardDomainRun = `*.${subdomain}.${sld}.${tld}`;

const serverType = config.HETZNER_SERVER_TYPE || "cx22";
const location = config.HETZNER_LOCATION || "nbg1";
const dnsPropagationMs = parseInt(
  config.DNS_PROPAGATION_WAIT_MS || "45000",
  10,
);
const sshKeyPath = config.SSH_PRIVATE_KEY_PATH.replace(/^~/, homedir());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string) {
  console.log(`[full-loop] ${msg}`);
}

function waitForSsh(ip: string, timeoutMs = 180_000): Promise<void> {
  return new Promise((res, rej) => {
    const deadline = Date.now() + timeoutMs;
    let attempts = 0;
    const tryConnect = () => {
      if (Date.now() > deadline) {
        return rej(
          new Error(`SSH not available on ${ip} after ${timeoutMs}ms`),
        );
      }
      attempts++;
      const sock = net.connect({ host: ip, port: 22 });
      sock.setTimeout(4000);
      sock.on("connect", () => {
        sock.destroy();
        res();
      });
      const retry = () => {
        sock.destroy();
        if (attempts % 6 === 1) log(`  still waiting for SSH on ${ip}...`);
        setTimeout(tryConnect, 5000);
      };
      sock.on("error", retry);
      sock.on("timeout", retry);
    };
    tryConnect();
  });
}

function runInstall(ip: string): Promise<string> {
  return new Promise((res, rej) => {
    const child = spawn(
      "ssh",
      [
        "-i",
        sshKeyPath,
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "ConnectTimeout=10",
        `root@${ip}`,
        "curl -fsSL https://raw.githubusercontent.com/ubershmekel/sitey/main/deploy/install-ubuntu.sh | bash",
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let output = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      output += chunk.toString();
    });
    child.on("exit", (code) => {
      if (code !== 0)
        return rej(new Error(`Install script exited with code ${code}`));
      res(output);
    });
    child.on("error", rej);
  });
}

function runPlaywright(ip: string, password: string): Promise<void> {
  return new Promise((res, rej) => {
    const pw = spawn(
      "npx",
      [
        "playwright",
        "test",
        "--config",
        "playwright.config.ts",
        "remote-playwright.test.ts",
        "--reporter=list",
      ],
      {
        shell: true,
        cwd: scriptDir,
        stdio: "inherit",
        env: {
          ...process.env,
          SITEY_HOST: ip,
          SITEY_PASSWORD: password,
          SITEY_EMAIL: config.EMAIL,
          SITEY_DOMAIN: wildcardDomainRun,
        },
      },
    );
    pw.on("exit", (code) => {
      if (code !== 0)
        return rej(new Error(`Playwright exited with code ${code}`));
      res();
    });
    pw.on("error", rej);
  });
}

// ---------------------------------------------------------------------------
// Worktree helpers (--worktree mode)
// ---------------------------------------------------------------------------

/** Run a shell script on the server via SSH, capturing stdout. */
function sshCmd(ip: string, script: string): Promise<string> {
  return new Promise((res, rej) => {
    const child = spawn(
      "ssh",
      [
        "-i",
        sshKeyPath,
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "ConnectTimeout=10",
        `root@${ip}`,
        script,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let output = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      output += chunk.toString();
    });
    child.on("exit", (code) => {
      if (code !== 0)
        return rej(new Error(`SSH command exited with code ${code}`));
      res(output);
    });
    child.on("error", rej);
  });
}

/**
 * Upload the local worktree to /opt/sitey on the server.
 * Uses tar piped over SSH so no rsync dependency is needed.
 * Excludes node_modules, .git, deploy/data, and e2e test artifacts.
 */
function uploadWorktree(ip: string): Promise<void> {
  return new Promise((res, rej) => {
    log("  tar-piping local worktree to server...");
    const tar = spawn(
      "tar",
      [
        "czf",
        "-",
        "--exclude=node_modules",
        "--exclude=.git",
        "--exclude=deploy/data",
        "--exclude=e2e/remote/test-results",
        "--exclude=e2e/remote/full-loop.env",
        "deploy",
        "server",
        "web",
        "package.json",
        "package-lock.json",
      ],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    const ssh = spawn(
      "ssh",
      [
        "-i",
        sshKeyPath,
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "ConnectTimeout=10",
        `root@${ip}`,
        "rm -rf /opt/sitey && mkdir -p /opt/sitey && tar xzf - -C /opt/sitey",
      ],
      { stdio: ["pipe", "inherit", "inherit"] },
    );
    tar.stdout!.pipe(ssh.stdin!);
    tar.stderr!.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    tar.on("exit", (code) => {
      if (code !== 0) {
        ssh.kill();
        rej(new Error(`tar exited with code ${code}`));
      }
    });
    ssh.on("exit", (code) => {
      if (code !== 0)
        return rej(new Error(`Upload SSH command exited with code ${code}`));
      res();
    });
    ssh.on("error", rej);
    tar.on("error", rej);
  });
}

/** Install Sitey from the local worktree instead of pulling from origin/main. */
async function runInstallWorktree(ip: string): Promise<string> {
  // Step 1: install system deps + Docker
  await sshCmd(
    ip,
    [
      "set -euo pipefail",
      "apt-get update -y",
      "apt-get install -y ca-certificates curl git",
      "if ! command -v docker >/dev/null 2>&1; then curl -fsSL https://get.docker.com | sh; fi",
      "systemctl enable --now docker",
    ].join(" && "),
  );

  // Step 2: upload local files
  await uploadWorktree(ip);

  // Step 3: docker compose up + generate password (output captured for password parsing)
  return sshCmd(
    ip,
    `set -euo pipefail
mkdir -p /opt/sitey/deploy/data
chown -R root:root /opt/sitey
cd /opt/sitey/deploy
PUBLIC_IP="$(curl -4fsSL https://api.ipify.org || true)"
if [[ -z "$PUBLIC_IP" ]]; then PUBLIC_IP="$(hostname -I | awk '{print $1}')"; fi
touch .env
grep -qE '^DATA_ROOT=' .env || echo 'DATA_ROOT=./data' >> .env
grep -qE '^SITEY_URL=' .env || echo "SITEY_URL=http://$PUBLIC_IP" >> .env
docker compose up -d --build
API_READY=0
for _ in $(seq 1 60); do
  if docker compose exec --interactive=false -T sitey-api sh -lc "node -v" >/dev/null 2>&1; then
    API_READY=1; break
  fi
  sleep 2
done
if [[ "$API_READY" -ne 1 ]]; then
  docker compose logs --tail=80 sitey-api || true
  echo "Sitey API did not become ready in time." && exit 1
fi
PASS_OUTPUT=""
for _ in $(seq 1 20); do
  if PASS_OUTPUT="$(docker compose exec --interactive=false -T sitey-api npm run bootstrap:generate-password 2>&1)"; then break; fi
  sleep 2
done
echo "$PASS_OUTPUT"`,
  );
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function since(start: number): string {
  const ms = Date.now() - start;
  return ms < 60_000
    ? `${(ms / 1000).toFixed(1)}s`
    : `${(ms / 60_000).toFixed(1)}m`;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

let serverId: number | null = null;
const totalStart = Date.now();

try {
  let stepStart = Date.now();
  log(`Creating Hetzner server (${serverType} @ ${location})...`);
  const server = await createServer({
    token: config.HCLOUD_TOKEN,
    name: `sitey-test-${Date.now()}`,
    serverType,
    location,
    sshKey: config.HETZNER_SSH_KEY,
  });
  serverId = server.id;
  log(`Server ready: id=${server.id}  ip=${server.ip}  (${since(stepStart)})`);

  stepStart = Date.now();
  log(`Configuring Namecheap DNS: ${wildcardDomainRun} → ${server.ip}`);
  await setWildcardRecord({
    apiUser: config.NAMECHEAP_API_USER,
    apiKey: config.NAMECHEAP_API_KEY,
    clientIp: config.NAMECHEAP_CLIENT_IP,
    sld,
    tld,
    subdomain,
    ip: server.ip,
  });
  log(`DNS updated. (${since(stepStart)})`);

  stepStart = Date.now();
  log("Waiting for SSH...");
  await waitForSsh(server.ip);
  log(`SSH is up. (${since(stepStart)})`);

  stepStart = Date.now();
  if (WORKTREE_MODE) {
    log("Uploading local worktree and installing...");
  } else {
    log("Running install script from origin/main...");
  }
  const installOutput = await (WORKTREE_MODE
    ? runInstallWorktree(server.ip)
    : runInstall(server.ip));

  const passwordMatch = installOutput.match(/password:\s+(\S+)/i);
  if (!passwordMatch) {
    throw new Error("Could not parse password from install output");
  }
  const password = passwordMatch[1];
  log(`Install complete. (${since(stepStart)})`);

  log(`Waiting ${dnsPropagationMs / 1000}s for DNS propagation...`);
  await sleep(dnsPropagationMs);

  stepStart = Date.now();
  log("Running Playwright tests...");
  await runPlaywright(server.ip, password);
  log(`All tests passed. (${since(stepStart)})`);
} finally {
  if (serverId !== null) {
    log(`Deleting Hetzner server ${serverId}...`);
    try {
      await deleteServer(config.HCLOUD_TOKEN, serverId);
      log("Server deleted.");
    } catch (err) {
      console.error("[full-loop] WARNING: failed to delete server:", err);
      console.error(
        `[full-loop] Delete manually at cloud.hetzner.com (id=${serverId})`,
      );
    }
  }

  log(`Removing Namecheap DNS records for ${wildcardDomainRun}...`);
  try {
    await deleteWildcardRecord({
      apiUser: config.NAMECHEAP_API_USER,
      apiKey: config.NAMECHEAP_API_KEY,
      clientIp: config.NAMECHEAP_CLIENT_IP,
      sld,
      tld,
      subdomain,
    });
    log("DNS records removed.");
  } catch (err) {
    console.error("[full-loop] WARNING: failed to remove DNS records:", err);
  }

  log(`Total time: ${since(totalStart)}`);
}
