#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const action = process.argv[2];
const allowedActions = ["generate-password"];

if (!action || !allowedActions.includes(action)) {
  console.error("Usage: npm run bootstrap:generate-password");
  process.exit(1);
}

const jsCandidates = ["dist/services/bootstrap.js", "dist/bootstrap.js"];
const jsEntry = jsCandidates.find((p) => existsSync(p));

const args = process.argv.slice(2);

if (jsEntry) {
  const result = spawnSync(
    process.execPath,
    ["--enable-source-maps", jsEntry, ...args],
    {
      stdio: "inherit",
    },
  );
  process.exit(result.status ?? 1);
}

const tsEntry = "src/services/bootstrap.ts";
if (existsSync(tsEntry)) {
  const result = spawnSync(process.execPath, [tsEntry, ...args], {
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

console.error(
  "Could not find bootstrap entrypoint. Tried: dist/services/bootstrap.js, dist/bootstrap.js, src/services/bootstrap.ts",
);
process.exit(1);
