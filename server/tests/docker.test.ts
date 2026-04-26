import { test } from "node:test";
import assert from "node:assert/strict";
import { generateDockerfile } from "../src/services/docker.ts";

test("generateDockerfile: single-line buildCommand", () => {
  const result = generateDockerfile("npm run build", "node dist/index.js");
  assert.ok(result.includes("RUN npm run build\n"), "single RUN line");
  assert.ok(result.includes('CMD ["sh", "-c", "node dist/index.js"]'));
});

test("generateDockerfile: multiline buildCommand joins with &&", () => {
  const result = generateDockerfile(
    "npm ci\nnpm run build",
    "node dist/index.js",
  );
  assert.ok(
    result.includes("RUN npm ci && npm run build\n"),
    "newlines should become &&",
  );
});

test("generateDockerfile: multiline buildCommand with Windows line endings", () => {
  const result = generateDockerfile(
    "npm ci\r\nnpm run build",
    "node dist/index.js",
  );
  assert.ok(result.includes("RUN npm ci && npm run build\n"));
});

test("generateDockerfile: multiline buildCommand filters blank lines", () => {
  const result = generateDockerfile(
    "npm ci\n\nnpm run build",
    "node dist/index.js",
  );
  assert.ok(result.includes("RUN npm ci && npm run build\n"));
  assert.ok(!result.includes("&&  &&"), "no doubled &&");
});

test("generateDockerfile: no buildCommand, only runCommand", () => {
  const result = generateDockerfile("", "node server.js");
  assert.ok(!result.includes("RUN"), "no RUN step when buildCommand is empty");
  assert.ok(result.includes('CMD ["sh", "-c", "node server.js"]'));
});

test("generateDockerfile: throws when both commands are empty", () => {
  assert.throws(
    () => generateDockerfile("", ""),
    /requires buildCommand or serverRunCommand/,
  );
});
