/**
 * Sitey CLI. Runs inside the sitey-api container:
 *   node src/cli.ts <command>
 *
 * On the host, deploy/sitey wraps this (`sitey <command>`) and handles the
 * host-only `install-cli` command itself.
 */

import { execSync } from "node:child_process";
import { db } from "./lib/db.ts";
import { generateOverridePassword } from "./services/bootstrap.ts";
import { loadExportInput, renderExportYaml } from "./services/export.ts";

const USAGE = `Usage: sitey <command>

Commands:
  generate-password   Print a one-time override password (locked out? use this)
  export              Print domains, repos, services and routes as YAML
  install-cli         (host only) Install the \`sitey\` command to /usr/local/bin
  help                Show this message`;

function runMigrations() {
  // The server runs migrations on startup, but the CLI can race it on a fresh
  // install (install-ubuntu.sh generates the password right after `up`).
  if (process.env.NODE_ENV !== "production") return;
  console.error("[cli] Running database migrations...");
  execSync("npm run db:migrate", { stdio: ["ignore", "inherit", "inherit"] });
}

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0] ?? "help";
  switch (cmd) {
    case "generate-password":
      runMigrations();
      await generateOverridePassword();
      return 0;
    case "export":
      process.stdout.write(renderExportYaml(await loadExportInput()));
      return 0;
    case "install-cli":
      console.error(
        "install-cli runs on the host, not in the container:\n" +
          "  sh /opt/sitey/deploy/sitey install-cli",
      );
      return 1;
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;
    default:
      console.error(`Unknown command: ${cmd}\n\n${USAGE}`);
      return 1;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} finally {
  await db.$disconnect();
}
