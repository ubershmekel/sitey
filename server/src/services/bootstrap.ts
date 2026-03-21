/**
 * First-run bootstrap:
 *  1. Run pending Prisma migrations.
 *  2. Ensure a JWT secret exists in SystemConfig (generate one if not).
 *  3. Call initJwtSecret() so the crypto module is ready before the server starts.
 *  4. Print the server's local IP addresses so the user knows where to connect.
 */

import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { db } from "../lib/db.js";

export async function bootstrap() {
  await db.$connect();

  // ── Sitey built-in project + root route ────────────────────────────────────
  // The sitey UI is itself a protected project with the catch-all root route
  // (no domain, no path prefix). This ensures it always appears in the UI and
  // that its root route cannot be accidentally deleted.
  let siteyProject = await db.project.findFirst({ where: { protected: true } });
  if (!siteyProject) {
    siteyProject = await db.project.create({
      data: {
        name: "sitey",
        protected: true,
        status: "running",
        deployMode: "server",
      },
    });
    await db.projectRoute.create({
      data: {
        projectId: siteyProject.id,
        protected: true,
        // domainId=null, subdomain="", pathPrefix="" → the root catch-all
      },
    });
    console.log("[bootstrap] Created built-in sitey project and root route.");
  }

  // ── Server IP ────────────────────────────────────────────────────────────
  const publicIp = await detectPublicIP();
  const localIps = getLocalIPs();
  if (publicIp) {
    await db.systemConfig.upsert({
      where: { key: "server_ip" },
      create: { key: "server_ip", value: publicIp },
      update: { value: publicIp },
    });
  }

  const setupDone = await db.systemConfig.findUnique({
    where: { key: "setup_complete" },
  });
  if (!setupDone) {
    const displayIps = publicIp ? [publicIp] : localIps;
    console.log(
      banner([
        "SITEY - FIRST RUN SETUP",
        "",
        "Open one of these addresses in your browser:",
        ...displayIps.map((ip) => `  http://${ip}`),
        "",
        "Complete the setup wizard to create your account.",
      ]),
    );
  }
}

async function detectPublicIP(): Promise<string | null> {
  const envServices = process.env.DETECT_IP_SERVICES;
  const services = envServices
    ? envServices
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : ["https://icanhazip.com", "https://api.ipify.org"];

  for (const url of services) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) continue;
      const ip = (await res.text()).trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip;
    } catch {
      // Try next service.
    }
  }

  // Fall back to first non-internal local IP.
  const local = getLocalIPs();
  return local[0] !== "localhost" ? local[0] : null;
}

function getLocalIPs(): string[] {
  const results: string[] = [];
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface ?? []) {
      if (addr.family === "IPv4" && !addr.internal) {
        results.push(addr.address);
      }
    }
  }
  return results.length ? results : ["localhost"];
}

function banner(lines: string[]): string {
  const inner = Math.max(...lines.map((l) => l.length)) + 4;
  const top = "╔" + "═".repeat(inner) + "╗";
  const bot = "╚" + "═".repeat(inner) + "╝";
  const rows = lines.map((l) => "║  " + l.padEnd(inner - 2) + "║");
  return [top, ...rows, bot].join("\n");
}

// Stores a hashed override password in SystemConfig. On login, if the entered
// password matches this hash, Sitey will upsert the given email as a user and
// log them in regardless of what their actual password is.
export async function generateOverridePassword() {
  const { generatePassword, hashPassword } = await import("./crypto.js");

  const password = generatePassword(24);
  const hash = await hashPassword(password);

  await db.systemConfig.upsert({
    where: { key: "override_password_hash" },
    create: { key: "override_password_hash", value: hash },
    update: { value: hash },
  });

  // Mark setup complete so the web wizard doesn't appear on first visit.
  await db.systemConfig.upsert({
    where: { key: "setup_complete" },
    create: { key: "setup_complete", value: new Date().toISOString() },
    update: {},
  });

  console.log(
    banner([
      "SITEY - OVERRIDE PASSWORD GENERATED",
      "",
      `Password: ${password}`,
      "",
      "Use this password with ANY email on the login page",
      "to take over that account.",
      "",
      "Save this; it will not be shown again.",
    ]),
  );

  await db.$disconnect();
}

function printUsage() {
  console.error("Usage: node bootstrap.ts <generate-password>");
}

// Allow running directly from either common build path:
// `node --enable-source-maps dist/services/bootstrap.js <generate-password>`
// or `node --enable-source-maps dist/bootstrap.js <generate-password>`
const isMain =
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1]?.endsWith("bootstrap.js");

if (isMain) {
  // Run migrations first. The main server does this in index.ts, but when
  // bootstrap.ts is invoked directly as a CLI the tables may not exist yet.
  if (process.env.NODE_ENV === "production") {
    console.log("[bootstrap] Running database migrations...");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execSync("npm run db:migrate", {
      stdio: "inherit",
      cwd: process.cwd(),
      shell: true,
      env: process.env,
    } as any);
    console.log("[bootstrap] Migrations complete.");
  }

  await db.$connect();
  const cmd = process.argv[2];
  if (cmd === "generate-password") {
    await generateOverridePassword();
  } else {
    printUsage();
    process.exit(1);
  }
}
