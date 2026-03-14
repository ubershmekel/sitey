import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const envPath = resolve("scripts/testing/reset-remote.env");

if (!existsSync(envPath)) {
  console.error("Missing scripts/testing/reset-remote.env");
  console.error(
    "Copy scripts/testing/reset-remote.env.example and fill values.",
  );
  process.exit(1);
}

const envFile = readFileSync(envPath, "utf8");
const config = {};

for (const rawLine of envFile.split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) continue;
  const idx = line.indexOf("=");
  if (idx <= 0) continue;
  const key = line.slice(0, idx).trim();
  const value = line.slice(idx + 1).trim();
  config[key] = value;
}

export default config;
