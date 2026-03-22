/**
 * Playwright global teardown — runs once after all tests complete.
 *
 * Responsibilities:
 *  1. Read the shared state file (e2e/.tmp-state.json).
 *  2. Delete the temp SQLite DB created for this run.
 *  3. Delete the state file itself.
 */

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const STATE_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  ".tmp-state.json",
);

export default async function globalTeardown() {
  if (!fs.existsSync(STATE_FILE)) return;

  let state: { dbPath: string } | null = null;
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    // If the file is corrupt, still try to remove it below.
  }

  if (state?.dbPath) {
    try {
      fs.unlinkSync(state.dbPath);
      console.log(`[global-teardown] Deleted temp DB: ${state.dbPath}`);
    } catch {
      // DB may not exist if setup failed before prisma db push
    }
    // SQLite may also create a -wal and -shm file
    for (const suffix of ["-wal", "-shm"]) {
      try {
        fs.unlinkSync(state.dbPath + suffix);
      } catch {
        // Ignore — these files only exist if the DB was written to
      }
    }
  }

  try {
    fs.unlinkSync(STATE_FILE);
  } catch {
    // Ignore
  }
}
