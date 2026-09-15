#!/usr/bin/env node
/**
 * siteyctl: control a Sitey server over HTTPS with an API token.
 * Design: docs/design/remote-cli.md. Run `siteyctl --help`.
 */

import { parseInvocation, UsageError } from "./args.ts";
import { describeError, EXIT } from "./api.ts";
import { contextFor, handlerFor, type Context } from "./commands.ts";
import { renderCommandHelp, renderTopHelp } from "./help.ts";

export async function main(
  argv: string[],
  overrides: Partial<Context> = {},
  io: { out(s: string): void; err(s: string): void } = {
    out: (s) => void process.stdout.write(s),
    err: (s) => void process.stderr.write(s),
  },
): Promise<number> {
  let inv;
  try {
    inv = parseInvocation(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    const help = err.command
      ? `siteyctl ${err.command.name} --help`
      : "siteyctl --help";
    io.err(`siteyctl: ${err.message}\nRun ${help} for usage.\n`);
    return EXIT.USAGE;
  }

  if (inv.kind === "help") {
    io.out(inv.command ? renderCommandHelp(inv.command) : renderTopHelp());
    return EXIT.OK;
  }

  const ctx = contextFor(inv, overrides);
  try {
    const result = await handlerFor(inv.command.name)(ctx);
    if (inv.json) io.out(`${JSON.stringify(result.json, null, 2)}\n`);
    else if (result.text) io.out(`${result.text}\n`);
    return result.exitCode ?? EXIT.OK;
  } catch (err) {
    let server;
    try {
      server = ctx.server();
    } catch {
      // No profile selected (the error is probably about that).
    }
    const report = describeError(err, server);
    io.err(`siteyctl: ${report.message}\n`);
    if (err instanceof UsageError)
      io.err(`Run siteyctl ${inv.command.name} --help for usage.\n`);
    return report.exitCode;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
