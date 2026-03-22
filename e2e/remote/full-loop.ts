/**
 * Full-loop end-to-end test:
 *   1. Provision a Hetzner server
 *   2. Configure Namecheap DNS (wildcard A record)
 *   3. Run the sitey install script via SSH
 *   4. Run Playwright tests against the live instance
 *   5. Tear down the server (always, even on failure)
 *
 * Config: e2e/remote/full-loop.env  (copy from full-loop.env.example)
 * Run:    npm run test:e2e-remote
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

const scriptDir = dirname(fileURLToPath(import.meta.url));
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
  log("Running install script...");
  const installOutput = await runInstall(server.ip);

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
