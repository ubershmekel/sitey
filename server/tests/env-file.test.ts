import { test } from "node:test";
import assert from "node:assert/strict";
import { EnvFileError, setEnvVar, unsetEnvVar } from "../src/lib/envFile.ts";
import { parseEnvString } from "../src/services/deployment.ts";

test("setEnvVar appends a new variable", () => {
  assert.equal(setEnvVar("", "A", "1"), "A=1");
  assert.equal(setEnvVar("# c\nA=1\n\n", "B", "2"), "# c\nA=1\nB=2");
});

test("setEnvVar replaces the first assignment in place and drops repeats", () => {
  assert.equal(
    setEnvVar("A=1\nexport B=2\nC=3\nB=4", "B", "new"),
    "A=1\nB=new\nC=3",
  );
});

test("setEnvVar leaves comments and continuation lines alone", () => {
  const raw =
    "KEY=-----BEGIN KEY-----\nMIIEvQIBADAN\n-----END KEY-----\n# B=commented\nB=1";
  assert.equal(
    setEnvVar(raw, "B", "2"),
    "KEY=-----BEGIN KEY-----\nMIIEvQIBADAN\n-----END KEY-----\n# B=commented\nB=2",
  );
});

test("values read back exactly through parseEnvString", () => {
  const values = [
    "plain",
    "",
    " padded ",
    '"quoted"',
    "'single'",
    '"',
    "'",
    "it's",
    "a=b=c",
    "# not a comment",
    "\ttab",
  ];
  let raw = "OTHER=x";
  for (const value of values) {
    raw = setEnvVar(raw, "V", value);
    assert.equal(parseEnvString(raw).V, value, JSON.stringify(value));
    assert.equal(parseEnvString(raw).OTHER, "x");
  }
});

test("setEnvVar rejects bad names and multi-line values", () => {
  assert.throws(() => setEnvVar("", "1A", "x"), EnvFileError);
  assert.throws(() => setEnvVar("", "A-B", "x"), EnvFileError);
  assert.throws(() => setEnvVar("", "A", "x\ny"), EnvFileError);
  assert.throws(() => setEnvVar("", "A", "x\ry"), EnvFileError);
});

test("unsetEnvVar removes every assignment and reports whether it did", () => {
  assert.deepEqual(unsetEnvVar("A=1\nB=2\nexport A=3", "A"), {
    envVars: "B=2",
    removed: true,
  });
  assert.deepEqual(unsetEnvVar("B=2", "A"), { envVars: "B=2", removed: false });
});
