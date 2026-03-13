import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const envPath = resolve("scripts/testing/reset-remote.env");

if (!existsSync(envPath)) {
  console.error("Missing scripts/testing/reset-remote.env");
  console.error(
    "Copy scripts/testing/reset-remote.env.example and fill values.",
  );
  process.exit(1);
}

const envFile = readFileSync(envPath, "utf8");
const config = {};

for (const rawLine of envFile.split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) continue;
  const idx = line.indexOf("=");
  if (idx <= 0) continue;
  const key = line.slice(0, idx).trim();
  const value = line.slice(idx + 1).trim();
  config[key] = value;
}

const sshTarget = config.SSH_TARGET;
const email = config.EMAIL;
const domain = config.DOMAIN;
const remoteDeployDir = config.REMOTE_DEPLOY_DIR || "/opt/sitey/deploy";
const refreshMode = config.REFRESH_MODE || "pull";

if (!sshTarget) {
  console.error("SSH_TARGET is required in scripts/testing/reset-remote.env");
  process.exit(1);
}

if (!email) {
  console.error("EMAIL is required in scripts/testing/reset-remote.env");
  process.exit(1);
}

if (!domain) {
  console.error("DOMAIN is required in scripts/testing/reset-remote.env");
  process.exit(1);
}

if (!["pull", "installer", "none"].includes(refreshMode)) {
  console.error("REFRESH_MODE must be one of: pull, installer, none");
  process.exit(1);
}

if (refreshMode === "installer" && remoteDeployDir !== "/opt/sitey/deploy") {
  console.error(
    "REFRESH_MODE=installer requires REMOTE_DEPLOY_DIR=/opt/sitey/deploy",
  );
  process.exit(1);
}

const sshHost = sshTarget.includes("@") ? sshTarget.split("@")[1] : sshTarget;

const shq = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
const remoteCommand = [
  `REMOTE_DEPLOY_DIR=${shq(remoteDeployDir)}`,
  `REFRESH_MODE=${shq(refreshMode)}`,
  "bash -s",
].join(" ");

const scriptDir = dirname(fileURLToPath(import.meta.url));
const remoteScript = readFileSync(
  resolve(scriptDir, "reset-remote.sh"),
  "utf8",
);

const child = spawn(
  "ssh",
  ["-o", "StrictHostKeyChecking=accept-new", sshTarget, remoteCommand],
  { stdio: ["pipe", "pipe", "inherit"] },
);

child.stdin.write(remoteScript);
child.stdin.end();

let sshOutput = "";
child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  sshOutput += chunk.toString();
});

child.on("exit", (code) => {
  if (code !== 0) {
    process.exit(code ?? 1);
  }

  console.log(`URL: http://${sshHost}`);

  const passwordMatch = sshOutput.match(/Password:\s+(\S+)/);
  if (!passwordMatch) {
    console.error("Could not parse password from reset output");
    process.exit(1);
  }

  const password = passwordMatch[1];

  console.log("\nRunning Playwright test...\n");

  const pw = spawn(
    "npx",
    [
      "playwright",
      "test",
      "--config",
      "playwright.config.mjs",
      "remote-playwright.test.mjs",
      "--reporter=list",
    ],
    {
      shell: true,
      cwd: scriptDir,
      stdio: "inherit",
      env: {
        ...process.env,
        SITEY_HOST: sshHost,
        SITEY_PASSWORD: password,
        SITEY_EMAIL: email,
        SITEY_DOMAIN: domain,
      },
    },
  );

  pw.on("exit", (pwCode) => process.exit(pwCode ?? 1));
  pw.on("error", (err) => {
    console.error(`Failed to run playwright: ${String(err)}`);
    process.exit(1);
  });
});

child.on("error", (err) => {
  console.error(`Failed to run ssh: ${String(err)}`);
  process.exit(1);
});
