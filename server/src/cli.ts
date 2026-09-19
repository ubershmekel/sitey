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
import {
  ApiTokenError,
  createApiToken,
  LOCAL_CLI_TOKEN_NAME,
  listApiTokens,
  revokeApiToken,
  writeLocalCliToken,
} from "./services/apiTokens.ts";

const USAGE = `Usage: sitey <command>

Commands:
  generate-password          Print a one-time override password (locked out? use this)
  export                     Print the server's configuration as YAML
  token create <name> [--user <email>]
                             Create an API token for siteyctl (printed once)
  token list                 List API tokens
  token revoke <name>        Delete an API token
  token local                (Re)create the "local-cli" token that siteyctl on
                             this VPS uses. siteyctl runs this when it has none.
  install-cli                (host only) Install the \`sitey\` and \`siteyctl\` commands to /usr/local/bin
  help                       Show this message

API tokens are root-equivalent on this VPS: Sitey controls the Docker socket.`;

function runMigrations() {
  // The server runs migrations on startup, but the CLI can race it on a fresh
  // install (install-ubuntu.sh generates the password right after `up`).
  if (process.env.NODE_ENV !== "production") return;
  console.error("[cli] Running database migrations...");
  // Output to stderr: stdout is reserved for results (e.g. a token piped into
  // `siteyctl login`).
  execSync("npm run db:migrate", { stdio: ["ignore", 2, 2] });
}

function formatDate(date: Date | null): string {
  return date ? date.toISOString().replace(/\.\d+Z$/, "Z") : "never";
}

async function tokenCommand(args: string[]): Promise<number> {
  const [sub, name, ...rest] = args;
  switch (sub) {
    case "create": {
      if (!name) break;
      let email: string | undefined;
      if (rest[0] === "--user" && rest[1]) email = rest[1];
      else if (rest.length) break;
      runMigrations();
      const created = await createApiToken(name, email);
      console.error(
        `Created API token "${created.name}" for ${created.email}. It is shown once:`,
      );
      process.stdout.write(`${created.token}\n`);
      console.error(
        "\nOn your machine: siteyctl login <server-name> <https://sitey-url>\n" +
          "This token is root-equivalent on this VPS. Revoke with: sitey token revoke " +
          created.name,
      );
      return 0;
    }
    case "local": {
      if (name) break;
      runMigrations();
      await writeLocalCliToken(Number(process.env.PORT ?? 3001));
      console.error(
        `Created API token "${LOCAL_CLI_TOKEN_NAME}" for siteyctl on this VPS. ` +
          `Revoke with: sitey token revoke ${LOCAL_CLI_TOKEN_NAME}`,
      );
      return 0;
    }
    case "list": {
      if (name) break;
      const tokens = await listApiTokens();
      if (!tokens.length) {
        console.error(
          "No API tokens. Create one with: sitey token create <name>",
        );
        return 0;
      }
      for (const t of tokens) {
        console.log(
          `${t.name ?? "(unnamed)"}\tuser=${t.user.email}\tcreated=${formatDate(t.createdAt)}\tlastUsed=${formatDate(t.lastUsedAt)}`,
        );
      }
      return 0;
    }
    case "revoke": {
      if (!name || rest.length) break;
      const count = await revokeApiToken(name);
      if (!count) {
        console.error(`No API token named "${name}".`);
        return 1;
      }
      console.error(`Revoked API token "${name}".`);
      return 0;
    }
  }
  console.error(`Usage error.\n\n${USAGE}`);
  return 1;
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
    case "token":
      return tokenCommand(argv.slice(1));
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
} catch (err) {
  if (!(err instanceof ApiTokenError)) throw err;
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
