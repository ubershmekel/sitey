import {
  COMMANDS,
  GLOBAL_OPTIONS,
  NEEDS_A_HUMAN,
  WORKFLOW_EXAMPLES,
  type CommandSpec,
  type OptionSpec,
} from "./spec.ts";

export function commandUsage(command: CommandSpec): string {
  const args = command.args.map((a) =>
    a.endsWith("?") ? `[<${a.slice(0, -1)}>]` : `<${a}>`,
  );
  return ["siteyctl", command.name, ...args].join(" ");
}

function optionLabel(name: string, o: OptionSpec): string {
  const flag = o.short ? `-${o.short}, --${name}` : `--${name}`;
  if (o.type === "boolean") return flag;
  if (o.type === "optional-string") return `${flag} [${o.placeholder}]`;
  return `${flag} <${o.placeholder}>${o.multiple ? "..." : ""}`;
}

function columns(rows: [string, string][], indent = "  "): string {
  const width = Math.max(...rows.map(([left]) => left.length));
  return rows
    .map(([left, right]) =>
      left.length > 34
        ? `${indent}${left}\n${indent}${" ".repeat(Math.min(width, 34) + 2)}${right}`
        : `${indent}${left.padEnd(Math.min(width, 34))}  ${right}`,
    )
    .join("\n");
}

const REFERENCE = `Arguments:
  <service>  A service's current name, or its id written service-42 or 42.
             Names can change (service rename); ids never do. Commands that
             create a service print its id, and --json output always has it.
  <route>    [http://]host[/pathPrefix], e.g. idea-a.andluck.com,
             andluck.com/blog, http://localhost/red. No scheme means HTTPS;
             http:// means HTTP-only. The host must be covered by a domain
             added to Sitey: exactly (andluck.com), or by a wildcard one level
             up (*.andluck.com covers idea-a.andluck.com).

Exit codes:
  0  success
  1  error (including: not live yet, deploy failed, auth rejected)
  2  invalid input or usage
  3  conflict or not found
  4  timed out (--wait)`;

export function renderTopHelp(): string {
  const commands = columns(
    COMMANDS.map((c) => [
      [
        c.name,
        ...c.args.map((a) =>
          a.endsWith("?") ? `[<${a.slice(0, -1)}>]` : `<${a}>`,
        ),
      ].join(" "),
      c.summary,
    ]),
  );
  const globals = columns(
    Object.entries(GLOBAL_OPTIONS).map(([n, o]) => [
      optionLabel(n, o),
      o.description,
    ]),
  );
  const examples = WORKFLOW_EXAMPLES.map(
    (w) => `  # ${w.title}\n${w.commands.map((c) => `  ${c}`).join("\n")}`,
  ).join("\n\n");
  const human = NEEDS_A_HUMAN.map((line) => `  - ${line}`).join("\n");

  return `siteyctl: control a Sitey server over HTTPS with an API token.

Usage: siteyctl <command> [arguments] [options]

Commands:
${commands}

Global options (every command):
${globals}

${REFERENCE}

Examples:
${examples}

Needs a human (siteyctl can't do these):
${human}

Profiles live in ${"$"}SITEYCTL_CONFIG, or ~/.config/sitey/servers.json
(%APPDATA%\\sitey\\servers.json on Windows).

Run siteyctl <command> --help for a command's options and examples.
`;
}

export function renderCommandHelp(command: CommandSpec): string {
  const options = Object.entries(command.options);
  const sections = [
    `Usage: ${commandUsage(command)}${options.length ? " [options]" : ""}`,
    command.summary + ".",
  ];
  if (command.description) sections.push(command.description);
  if (options.length) {
    sections.push(
      `Options:\n${columns(options.map(([n, o]) => [optionLabel(n, o), o.description]))}`,
    );
  }
  sections.push(
    `Global options:\n${columns(
      Object.entries(GLOBAL_OPTIONS).map(([n, o]) => [
        optionLabel(n, o),
        o.description,
      ]),
    )}`,
  );
  sections.push(
    `Examples:\n${command.examples.map((e) => `  ${e}`).join("\n")}`,
  );
  sections.push(
    "Run siteyctl --help for <service>/<route> forms and exit codes.",
  );
  return sections.join("\n\n") + "\n";
}
