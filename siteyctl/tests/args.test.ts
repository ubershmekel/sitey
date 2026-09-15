import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInvocation, UsageError } from "../src/args.ts";

function run(argv: string[]) {
  const inv = parseInvocation(argv);
  assert.equal(inv.kind, "run");
  return inv as Extract<typeof inv, { kind: "run" }>;
}

test("global options work before or after the command", () => {
  const before = run([
    "--server",
    "andluck",
    "--json",
    "service",
    "get",
    "idea-a",
  ]);
  const after = run(["service", "get", "idea-a", "--server=andluck", "--json"]);
  for (const inv of [before, after]) {
    assert.equal(inv.command.name, "service get");
    assert.deepEqual(inv.args, { service: "idea-a" });
    assert.equal(inv.server, "andluck");
    assert.equal(inv.json, true);
  }
});

test("one-word commands take positionals that look like subcommands", () => {
  const inv = run(["status", "get"]);
  assert.equal(inv.command.name, "status");
  assert.deepEqual(inv.args, { service: "get" });
  assert.deepEqual(run(["status"]).args, { service: undefined });
});

test("repeatable and optional-value options", () => {
  const inv = run([
    "service",
    "create",
    "idea-c",
    "--mode",
    "server",
    "--route",
    "a.andluck.com",
    "--route",
    "b.andluck.com/api",
    "--dockerfile",
  ]);
  assert.deepEqual(inv.options.route, ["a.andluck.com", "b.andluck.com/api"]);
  assert.equal(inv.options.dockerfile, "Dockerfile");
  assert.equal(
    run([
      "service",
      "set",
      "x",
      "--dockerfile",
      "api/Dockerfile",
      "--port",
      "8080",
    ]).options.dockerfile,
    "api/Dockerfile",
  );
  assert.equal(
    run(["service", "set", "x", "--dockerfile", "--port", "8080"]).options
      .dockerfile,
    "Dockerfile",
  );
});

test("usage errors", () => {
  const cases: [string[], RegExp][] = [
    [["service", "get"], /Missing <service>/],
    [["route", "add", "idea-a"], /Missing <route>/],
    [["domains", "extra"], /Unexpected argument "extra"/],
    [["service"], /needs a subcommand/],
    [["service", "explode", "x"], /needs a subcommand/],
    [["frobnicate"], /Unknown command "frobnicate"/],
    [["services", "--nope"], /Unknown option '--nope'/],
    [["deploy", "x", "--timeout"], /argument missing/],
  ];
  for (const [argv, message] of cases) {
    assert.throws(
      () => parseInvocation(argv),
      (err: unknown) => {
        assert.ok(err instanceof UsageError, argv.join(" "));
        assert.match((err as Error).message, message, argv.join(" "));
        return true;
      },
    );
  }
});
