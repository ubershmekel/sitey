/**
 * Playwright E2E configuration.
 *
 * Three webServer processes (started in order):
 *   1. Mock external server  :3334  — intercepts Caddy admin, GitHub API, IP detect
 *   2. Sitey API             :4001  — real Fastify/tRPC server, isolated test DB
 *   3. Sitey Web             :4000  — real Vite dev server, proxies /trpc → :4001
 *
 * The temp SQLite DB path is generated here (at config evaluation time).
 * `prisma db push` is run synchronously in the config — this is the only way
 * to guarantee the schema is applied before webServers start (in Playwright
 * 1.x, webServers can start before globalSetup completes).
 * global-setup.ts reads the state file for any tests that need context.
 * global-teardown.ts cleans up the temp files.
 *
 * Why SITEY_API_INTERNAL=sitey-api:3001?
 *   caddy.ts auto-detects `IS_HOST_RUN_DEV` from CADDY_ADMIN_URL.  Because
 *   the mock Caddy admin URL has hostname `localhost`, IS_HOST_RUN_DEV=true and
 *   SITEY_API_INTERNAL would default to `host.docker.internal:3001`.  Caddy
 *   never actually runs in tests, but we still want Caddyfile bodies to contain
 *   the stable string `sitey-api:3001` for test assertions — the same value
 *   production uses — so we pin it explicitly here.
 *
 * Why 127.0.0.1 for readiness URLs?
 *   On Windows, Node.js may resolve `localhost` → ::1 (IPv6) while the servers
 *   bind to 127.0.0.1 (IPv4).  Use the explicit IPv4 address to avoid timeouts.
 */

import { defineConfig } from "@playwright/test";
import { execSync } from "child_process";
import path from "path";
import os from "os";
import fs from "fs";
import { fileURLToPath } from "url";

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(E2E_DIR, "../..");
const SERVER_DIR = path.join(REPO_ROOT, "server");
const WEB_DIR = path.join(REPO_ROOT, "web");

// ── Shared state file ─────────────────────────────────────────────────────────
// Written here (at config eval time) so that both webServer.env and global-setup
// can read the same DB path.
const STATE_FILE = path.join(E2E_DIR, ".tmp-state.json");

// Use forward slashes in the SQLite path so Prisma/better-sqlite3 handles it
// correctly on Windows (backslashes in `file:` URLs cause silent open failures).
const DB_PATH = path
  .join(os.tmpdir(), `sitey-e2e-${Date.now()}-${process.pid}.db`)
  .replace(/\\/g, "/");

fs.writeFileSync(STATE_FILE, JSON.stringify({ dbPath: DB_PATH }));

// ── Apply schema to fresh test DB ─────────────────────────────────────────────
// Run synchronously here (before webServers start) — not in globalSetup, because
// in Playwright 1.x webServers can start in parallel with / before globalSetup.
console.log(`[e2e] Applying schema to test DB: ${DB_PATH}`);
execSync("npm run db:push", {
  cwd: SERVER_DIR,
  env: { ...process.env, DATABASE_URL: `file:${DB_PATH}` },
  stdio: "inherit",
});
console.log("[e2e] Test DB ready.");

// ── API server env ─────────────────────────────────────────────────────────────
const apiEnv: Record<string, string> = {
  // Isolated per-run SQLite DB (overrides server/.env value — Node's
  // --env-file skips vars that are already set in the environment).
  DATABASE_URL: `file:${DB_PATH}`,
  // Use a non-default port so tests don't collide with a running dev server.
  PORT: "4001",
  // Redirect Caddy admin calls to the mock server.
  // Use 127.0.0.1 not localhost — on Windows, Node.js in the API subprocess
  // may resolve localhost → ::1 (IPv6) but the mock server binds to 127.0.0.1.
  CADDY_ADMIN_URL: "http://127.0.0.1:3334/caddy",
  // Redirect GitHub API calls to the mock server (same IPv4 caveat).
  GITHUB_API_BASE: "http://127.0.0.1:3334/github",
  // TLS probe target — nothing listens here; probes resolve as "error" status,
  // which is fine (the tests don't assert TLS cert state).
  CADDY_TLS_HOST: "127.0.0.1",
  CADDY_TLS_PORT: "19999",
  // Redirect IP-detect HTTP calls to the mock server (same IPv4 caveat).
  DETECT_IP_SERVICES: "http://127.0.0.1:3334/detectip",
  // Pin the internal hostname used in Caddyfile reverse_proxy directives to
  // the production value so test assertions match production output.
  // Without this, IS_HOST_RUN_DEV=true (because 127.0.0.1 in CADDY_ADMIN_URL
  // is a local address) would cause the default to be `host.docker.internal:3001`.
  SITEY_API_INTERNAL: "sitey-api:3001",
};

// ── Web server env ─────────────────────────────────────────────────────────────
const webEnv: Record<string, string> = {
  PORT: "4000",
  API_PROXY_TARGET: "http://127.0.0.1:4001",
};

export default defineConfig({
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",

  testDir: "./",
  testMatch: "**/*.test.ts",

  use: {
    baseURL: "http://localhost:4000",
    ignoreHTTPSErrors: true,
  },

  workers: 1,
  retries: 0,

  webServer: [
    // 1. Mock external server — must be ready before the API tries to push
    //    its initial Caddyfile on startup.
    {
      command: "npm run dev:e2e-mockserver",
      cwd: REPO_ROOT,
      url: "http://127.0.0.1:3334/__requests",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    // 2. Sitey API — real Fastify server against the isolated test DB
    {
      command: "npm run dev",
      cwd: SERVER_DIR,
      env: apiEnv,
      url: "http://127.0.0.1:4001/health",
      reuseExistingServer: false,
      timeout: 60_000,
    },
    // 3. Sitey Web — Vite dev server on port 4000; proxies /trpc + /health → :4001.
    {
      command: "npm run dev",
      cwd: WEB_DIR,
      env: webEnv,
      url: "http://127.0.0.1:4000",
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
