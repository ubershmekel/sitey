import { parseArgs } from "node:util";
import {
  COMMANDS,
  GLOBAL_OPTIONS,
  type CommandSpec,
  type OptionSpec,
} from "./spec.ts";

export class UsageError extends Error {
  command: CommandSpec | undefined;
  constructor(message: string, command?: CommandSpec) {
    super(message);
    this.command = command;
  }
}

export type OptionValues = Record<
  string,
  string | boolean | string[] | undefined
>;

export type Invocation =
  | { kind: "help"; command?: CommandSpec }
  | {
      kind: "run";
      command: CommandSpec;
      args: Record<string, string | undefined>;
      options: OptionValues;
      server: string | undefined;
      json: boolean;
    };

function isOption(token: string): boolean {
  return token.startsWith("-") && token !== "-";
}

/** Indexes of tokens that aren't options or values of global string options. */
function wordIndexes(argv: string[]): number[] {
  const words: number[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--") break;
    if (token === "--server") {
      i++;
      continue;
    }
    if (!isOption(token)) words.push(i);
  }
  return words;
}

function findCommand(argv: string[]): {
  command: CommandSpec;
  consumed: number[];
} | null {
  const words = wordIndexes(argv);
  if (!words.length) return null;
  const first = argv[words[0]];
  if (words.length > 1 && words[1] === words[0] + 1) {
    const two = `${first} ${argv[words[1]]}`;
    const command = COMMANDS.find((c) => c.name === two);
    if (command) return { command, consumed: [words[0], words[1]] };
  }
  const command = COMMANDS.find((c) => c.name === first);
  return command ? { command, consumed: [words[0]] } : null;
}

function groupHint(word: string): string | null {
  const subcommands = COMMANDS.filter((c) => c.name.startsWith(`${word} `));
  if (!subcommands.length) return null;
  return `"${word}" needs a subcommand: ${subcommands.map((c) => c.name).join(", ")}.`;
}

function toParseArgsOptions(options: Record<string, OptionSpec>) {
  return Object.fromEntries(
    Object.entries(options).map(([name, o]) => [
      name,
      {
        type: o.type === "boolean" ? ("boolean" as const) : ("string" as const),
        ...(o.multiple ? { multiple: true } : {}),
        ...(o.short ? { short: o.short } : {}),
      },
    ]),
  );
}

/** `--flag` alone → `--flag=<default>`; `--flag value` → `--flag=value`. */
function expandOptionalValues(
  tokens: string[],
  options: Record<string, OptionSpec>,
): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const name = token.startsWith("--") ? token.slice(2) : "";
    const spec = options[name];
    if (spec?.type === "optional-string") {
      const next = tokens[i + 1];
      if (next !== undefined && !isOption(next)) {
        out.push(`--${name}=${next}`);
        i++;
      } else {
        out.push(`--${name}=${spec.defaultValue ?? ""}`);
      }
      continue;
    }
    out.push(token);
  }
  return out;
}

export function parseInvocation(argv: string[]): Invocation {
  if (!argv.length) return { kind: "help" };
  if (argv[0] === "help") {
    const rest = argv.slice(1);
    if (!rest.length) return { kind: "help" };
    const found = findCommand(rest);
    if (!found) {
      throw new UsageError(
        groupHint(rest[0]) ?? `Unknown command "${rest.join(" ")}".`,
      );
    }
    return { kind: "help", command: found.command };
  }

  const found = findCommand(argv);
  if (!found) {
    const words = wordIndexes(argv);
    if (!words.length) {
      if (argv.includes("--help") || argv.includes("-h"))
        return { kind: "help" };
      throw new UsageError("Missing command.");
    }
    const word = argv[words[0]];
    throw new UsageError(groupHint(word) ?? `Unknown command "${word}".`);
  }

  const { command } = found;
  const allOptions = { ...GLOBAL_OPTIONS, ...command.options };
  const rest = expandOptionalValues(
    argv.filter((_, i) => !found.consumed.includes(i)),
    allOptions,
  );

  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: toParseArgsOptions(allOptions),
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    throw new UsageError((err as Error).message, command);
  }

  const { server, json, help, ...options } = parsed.values as OptionValues;
  if (help) return { kind: "help", command };

  const required = command.args.filter((a) => !a.endsWith("?"));
  const positionals = parsed.positionals;
  if (
    positionals.length < required.length ||
    positionals.length > command.args.length
  ) {
    const expected = command.args.map((a) => `<${a.replace(/\?$/, "")}>`);
    throw new UsageError(
      positionals.length < required.length
        ? `Missing ${expected.slice(positionals.length, required.length).join(" ")}.`
        : `Unexpected argument "${positionals[command.args.length]}".`,
      command,
    );
  }
  const args = Object.fromEntries(
    command.args.map((a, i) => [a.replace(/\?$/, ""), positionals[i]]),
  );

  return {
    kind: "run",
    command,
    args,
    options,
    server: server as string | undefined,
    json: Boolean(json),
  };
}
