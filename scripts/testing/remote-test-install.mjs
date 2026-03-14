import { spawn } from "node:child_process";
import config from "./load-config.mjs";

const sshTarget = config.SSH_TARGET;

if (!sshTarget) {
  console.error("SSH_TARGET is required in scripts/testing/reset-remote.env");
  process.exit(1);
}

console.log(`Running installer on ${sshTarget}...\n`);

const child = spawn(
  "ssh",
  [
    "-o",
    "StrictHostKeyChecking=accept-new",
    sshTarget,
    "curl -fsSL https://raw.githubusercontent.com/ubershmekel/sitey/main/deploy/install-ubuntu.sh | bash",
  ],
  { stdio: "inherit" },
);

child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (err) => {
  console.error(`Failed to run ssh: ${String(err)}`);
  process.exit(1);
});
