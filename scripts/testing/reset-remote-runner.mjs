import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const envPath = resolve("scripts/testing/reset-remote.env");

if (!existsSync(envPath)) {
  console.error("Missing scripts/testing/reset-remote.env");
  console.error("Copy scripts/testing/reset-remote.env.example and fill values.");
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
const siteyUrl = config.SITEY_URL || "";
const remoteDeployDir = config.REMOTE_DEPLOY_DIR || "";
const refreshMode = config.REFRESH_MODE || "pull";

if (!sshTarget) {
  console.error("SSH_TARGET is required in scripts/testing/reset-remote.env");
  process.exit(1);
}

if (!["pull", "installer", "none"].includes(refreshMode)) {
  console.error("REFRESH_MODE must be one of: pull, installer, none");
  process.exit(1);
}

if (refreshMode === "installer" && remoteDeployDir !== "/opt/sitey/deploy") {
  console.error("REFRESH_MODE=installer requires REMOTE_DEPLOY_DIR=/opt/sitey/deploy");
  process.exit(1);
}

const shq = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
const remoteCommand = [
  `REMOTE_DEPLOY_DIR=${shq(remoteDeployDir)}`,
  `SITEY_URL=${shq(siteyUrl)}`,
  `REFRESH_MODE=${shq(refreshMode)}`,
  "bash -s",
].join(" ");

const remoteScript = `set -euo pipefail

if [[ "\${REFRESH_MODE}" == "installer" ]]; then
  curl -fsSL https://raw.githubusercontent.com/ubershmekel/sitey/main/deploy/install-ubuntu.sh | bash
elif [[ "\${REFRESH_MODE}" == "pull" ]]; then
  SITEY_ROOT="$(cd "\${REMOTE_DEPLOY_DIR}/.." && pwd)"
  git -C "\${SITEY_ROOT}" pull --ff-only
fi

cd "\${REMOTE_DEPLOY_DIR}"

if [[ -n "\${SITEY_URL}" ]]; then
  touch .env
  if grep -qE '^SITEY_URL=' .env; then
    sed -i "s|^SITEY_URL=.*|SITEY_URL=\${SITEY_URL}|" .env
  else
    echo "SITEY_URL=\${SITEY_URL}" >> .env
  fi
fi

docker compose down
rm -f data/sitey.db
rm -rf data/projects
mkdir -p data/projects
docker compose up -d --build

for _ in $(seq 1 60); do
  if docker compose exec --interactive=false -T sitey-api sh -lc "node -v" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

PASS_OUTPUT="$(docker compose exec --interactive=false -T sitey-api npm run -s bootstrap:init 2>&1 || true)"
if [[ -z "\${PASS_OUTPUT}" ]]; then
  echo "Failed to get password from bootstrap:init"
  exit 1
fi

PASSWORD="$(printf "%s\\n" "\${PASS_OUTPUT}" | sed -n 's/.*Password: \\([^[:space:]]\\+\\).*/\\1/p' | head -n1)"

echo "----- SITEY RESET COMPLETE -----"
if [[ -n "\${SITEY_URL}" ]]; then
  echo "URL: \${SITEY_URL}"
fi
if [[ -n "\${PASSWORD}" ]]; then
  echo "Password: \${PASSWORD}"
else
  echo "Password parse failed. Raw output:"
  printf "%s\\n" "\${PASS_OUTPUT}"
fi
`;

const child = spawn(
  "ssh",
  ["-o", "StrictHostKeyChecking=accept-new", sshTarget, remoteCommand],
  { stdio: ["pipe", "inherit", "inherit"] },
);

child.stdin.write(remoteScript);
child.stdin.end();

child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (err) => {
  console.error(`Failed to run ssh: ${String(err)}`);
  process.exit(1);
});
