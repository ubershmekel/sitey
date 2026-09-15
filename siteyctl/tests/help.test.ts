import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInvocation } from "../src/args.ts";
import { HANDLED_COMMANDS } from "../src/commands.ts";
import { renderCommandHelp, renderTopHelp } from "../src/help.ts";
import { COMMANDS, WORKFLOW_EXAMPLES } from "../src/spec.ts";

/** Minimal POSIX-ish word splitting: quotes, and && / | / < separators. */
function shellSegments(line: string): string[][] {
  const segments: string[][] = [[]];
  let word = "";
  let inWord = false;
  let quote: string | null = null;
  const endWord = () => {
    if (inWord) segments[segments.length - 1].push(word);
    word = "";
    inWord = false;
  };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (ch === " ") {
      endWord();
    } else if (
      ch === "|" ||
      ch === "<" ||
      (ch === "&" && line[i + 1] === "&")
    ) {
      endWord();
      if (ch === "&") i++;
      // A redirect's target isn't part of the command.
      if (ch === "<") {
        while (line[i + 1] === " ") i++;
        while (i + 1 < line.length && line[i + 1] !== " ") i++;
      }
      segments.push([]);
    } else {
      word += ch;
      inWord = true;
    }
  }
  assert.equal(quote, null, `unterminated quote in: ${line}`);
  endWord();
  return segments.filter((s) => s.length);
}

function siteyctlInvocations(line: string): string[][] {
  return shellSegments(line)
    .filter((words) => words[0] === "siteyctl")
    .map((words) => words.slice(1));
}

const allExamples = [
  ...COMMANDS.flatMap((c) =>
    c.examples.map((e) => ({ command: c.name, line: e })),
  ),
  ...WORKFLOW_EXAMPLES.flatMap((w) =>
    w.commands.map((e) => ({ command: null, line: e })),
  ),
];

test("every example in the help text parses as a valid command", () => {
  for (const { command, line } of allExamples) {
    const invocations = siteyctlInvocations(line);
    assert.ok(invocations.length, `no siteyctl invocation in: ${line}`);
    for (const argv of invocations) {
      const inv = parseInvocation(argv);
      assert.equal(inv.kind, "run", line);
      if (command && inv.kind === "run" && invocations.length === 1) {
        assert.equal(inv.command.name, command, line);
      }
    }
  }
});

test("every command has an example and a handler", () => {
  for (const c of COMMANDS) {
    assert.ok(c.examples.length, `${c.name} has no example`);
    assert.ok(
      c.examples.some((e) =>
        siteyctlInvocations(e).some((argv) => {
          const inv = parseInvocation(argv);
          return inv.kind === "run" && inv.command.name === c.name;
        }),
      ),
      `${c.name}'s examples don't run ${c.name}`,
    );
    assert.ok(HANDLED_COMMANDS.includes(c.name), `${c.name} has no handler`);
  }
  assert.equal(HANDLED_COMMANDS.length, COMMANDS.length);
});

test("top-level help covers the agent guide sections", () => {
  const help = renderTopHelp();
  for (const section of [
    "Commands:",
    "Arguments:",
    "Exit codes:",
    "Examples:",
    "Needs a human",
    "--json",
    "service-42",
  ]) {
    assert.ok(help.includes(section), section);
  }
  for (const c of COMMANDS) assert.ok(help.includes(c.name), c.name);
});

test("command help includes usage, options and examples", () => {
  const help = renderCommandHelp(
    COMMANDS.find((c) => c.name === "service create")!,
  );
  assert.match(help, /^Usage: siteyctl service create <name> \[options\]/);
  assert.match(help, /--dockerfile \[path\]/);
  assert.match(help, /--route <route>\.\.\./);
  assert.match(help, /Examples:\n {2}siteyctl service create/);
});

test("help routes: --help, -h, help <command>", () => {
  assert.deepEqual(parseInvocation([]), { kind: "help" });
  assert.deepEqual(parseInvocation(["--help"]), { kind: "help" });
  const byFlag = parseInvocation(["route", "add", "-h"]);
  const byWord = parseInvocation(["help", "route", "add"]);
  assert.equal(byFlag.kind === "help" && byFlag.command?.name, "route add");
  assert.equal(byWord.kind === "help" && byWord.command?.name, "route add");
});
