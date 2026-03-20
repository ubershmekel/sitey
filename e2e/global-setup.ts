/**
 * Playwright global setup — runs once before any tests.
 *
 * Note: `prisma db push` is intentionally run in playwright.config.ts at
 * config evaluation time (not here), because in Playwright 1.x webServers
 * can start before globalSetup completes.  Running db push synchronously in
 * the config guarantees the schema is ready before the API server boots.
 *
 * This file exists to satisfy the spec's structural requirement and provides
 * a convenient hook for any future pre-test setup that doesn't need to happen
 * before webServers start (e.g. seeding data via HTTP after servers are up).
 */

import path from "path";
import fs from "fs";

const STATE_FILE = path.join(__dirname, ".tmp-state.json");

export default async function globalSetup() {
  if (!fs.existsSync(STATE_FILE)) {
    throw new Error(
      `[global-setup] State file not found: ${STATE_FILE}\n` +
        "This file is written by playwright.config.ts at evaluation time.",
    );
  }

  const state: { dbPath: string } = JSON.parse(
    fs.readFileSync(STATE_FILE, "utf8"),
  );

  console.log(`[global-setup] Test DB path: ${state.dbPath}`);
}
