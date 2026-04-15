/**
 * E2E test for deploy/updater/update-docker.sh
 *
 * Spins up a toy Docker Compose stack (toy-app + toy-builder + updater),
 * then exercises the real update script via env-var overrides.
 *
 * Scenarios:
 *   1. Basic update — code changed, script unchanged
 *   2. Script self-replacement — script swapped on disk mid-execution
 *   3. Script deletion — script removed from disk mid-execution (rename sim)
 *
 * Run:  npm run test:updater
 */

import { execSync, type ExecSyncOptions } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const testDir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(testDir, "fixture");
const fixtureDeployDir = resolve(fixtureDir, "deploy");
const composeFile = resolve(fixtureDeployDir, "docker-compose.yml");
const markerFile = resolve(fixtureDeployDir, "app/marker");
const dataDir = resolve(fixtureDeployDir, "data");
const updateLog = resolve(dataDir, ".update.log");
const runLogPath = resolve(testDir, "run-log.json");

// The real update script — we copy it into the fixture at test time
const realScript = resolve(testDir, "../update-docker.sh");
const fixtureScript = resolve(fixtureDir, "deploy/updater/update-docker.sh");

// ---------------------------------------------------------------------------
// Run log — tracks compose stack so a crashed run can be cleaned up next time
// ---------------------------------------------------------------------------

interface RunLogEntry {
  composeFile: string;
  startedAt: string;
}

function loadRunLog(): RunLogEntry | null {
  try {
    if (existsSync(runLogPath)) {
      return JSON.parse(readFileSync(runLogPath, "utf8")) as RunLogEntry;
    }
  } catch {
    // corrupted — ignore
  }
  return null;
}

function saveRunLog(entry: RunLogEntry): void {
  writeFileSync(runLogPath, JSON.stringify(entry, null, 2) + "\n", "utf8");
}

function clearRunLog(): void {
  try {
    writeFileSync(runLogPath, "", "utf8");
  } catch {
    // ignore
  }
}

function cleanupStaleRun(): void {
  const entry = loadRunLog();
  if (!entry) return;

  console.log(`Found stale run from ${entry.startedAt}, cleaning up...`);
  try {
    execSync(
      `docker compose -f ${entry.composeFile} down -v --remove-orphans --timeout 5`,
      { encoding: "utf8", stdio: "pipe" },
    );
    console.log("  Stale stack removed.");
  } catch {
    console.log("  Stale stack already gone or could not be removed.");
  }
  clearRunLog();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DC = `docker compose -f ${composeFile}`;
const UPDATER = "sitey-updater-test-updater-1";

const execOpts: ExecSyncOptions = { encoding: "utf8" as const, stdio: "pipe" };

function dc(args: string): string {
  return execSync(`${DC} ${args}`, execOpts) as string;
}

/** docker exec with env overrides pointing at the toy services. */
const ENV_FLAGS = [
  "-e UPDATE_SERVICES=toy-app",
  "-e UPDATE_BUILDER=toy-builder",
  '-e "UPDATE_BUILD_SERVICES=toy-builder toy-app"',
].join(" ");

function updaterExec(cmd: string): string {
  return execSync(
    `docker exec ${ENV_FLAGS} ${UPDATER} sh -c ${shellEscape(cmd)}`,
    { ...execOpts, timeout: 120_000 },
  ) as string;
}

function updaterExecRaw(cmd: string): string {
  return execSync(`docker exec ${UPDATER} sh -c ${shellEscape(cmd)}`, {
    ...execOpts,
    timeout: 120_000,
  }) as string;
}

function shellEscape(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`")}"`;
}

function getStartedAt(): string {
  return (
    execSync(
      `docker inspect --format "{{.State.StartedAt}}" sitey-updater-test-toy-app-1`,
      execOpts,
    ) as string
  ).trim();
}

function readLog(): string {
  try {
    return readFileSync(updateLog, "utf8");
  } catch {
    return "";
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

function randomToken(): string {
  return randomBytes(12).toString("hex");
}

const SCRIPT_PATH = "/sitey-root/deploy/updater/update-docker.sh";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function setup(): void {
  // Clean up any leftover stack from a previous crashed run
  cleanupStaleRun();

  mkdirSync(resolve(fixtureDir, "deploy/updater"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  // Copy the real update script into the fixture
  copyFileSync(realScript, fixtureScript);

  // Create initial marker file (overwritten by each scenario)
  writeFileSync(markerFile, "initial\n");

  // Record what we're about to create so a future run can clean up if we crash
  saveRunLog({ composeFile, startedAt: new Date().toISOString() });

  console.log("Setting up toy stack...");
  dc("up -d --build");

  // Wait for the one-shot builder to finish its initial run
  execSync(`docker wait sitey-updater-test-toy-builder-1`, {
    ...execOpts,
    timeout: 30_000,
  });
}

function teardown(): void {
  console.log("\nTearing down...");
  try {
    dc("down -v --remove-orphans --timeout 5");
  } catch (e) {
    console.error("Teardown warning:", (e as Error).message);
  }
  clearRunLog();
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

function scenario1_basicUpdate(): void {
  console.log("\n── Scenario 1: Basic update ──");

  const token = randomToken();
  writeFileSync(markerFile, token);
  const beforeStartedAt = getStartedAt();

  updaterExec(`sh ${SCRIPT_PATH}`);

  const afterStartedAt = getStartedAt();
  const log = readLog();

  assert(log.includes("=== update complete ==="), "update completed");
  assert(beforeStartedAt !== afterStartedAt, "toy-app container was recreated");

  // Verify the new marker was baked into the rebuilt image
  const markerInContainer = (
    execSync(
      `docker exec sitey-updater-test-toy-app-1 cat /etc/marker`,
      execOpts,
    ) as string
  ).trim();
  assert(markerInContainer === token, `marker baked into image (${token})`);

  // Verify builder ran and produced output
  const builderOutput = readFileSync(
    resolve(dataDir, "builder-output/marker"),
    "utf8",
  ).trim();
  assert(builderOutput === token, "builder wrote marker to output volume");

  assert(log.includes("[sitey-updater]"), "log uses correct prefix");
}

function scenario2_scriptSelfReplacement(): void {
  console.log("\n── Scenario 2: Script self-replacement ──");

  const token = randomToken();
  writeFileSync(markerFile, token);

  const origScript = readFileSync(fixtureScript, "utf8");
  const v2Script = origScript.replace(
    /\[sitey-updater\]/g,
    "[sitey-updater-v2]",
  );

  // Replicate the system.ts pattern (line 98):
  //   1. Read script into container-local temp file (simulates cat into $S)
  //   2. Overwrite script on disk (simulates git pull bringing v2)
  //   3. Run the saved v1 copy
  updaterExecRaw(`cp ${SCRIPT_PATH} /tmp/v1.sh`);
  writeFileSync(fixtureScript, v2Script);
  updaterExec("sh /tmp/v1.sh");

  const log = readLog();

  assert(log.includes("=== update complete ==="), "update completed");
  assert(
    log.includes("[sitey-updater]"),
    "v1 ran from memory (correct prefix)",
  );
  assert(!log.includes("[sitey-updater-v2]"), "v2 did NOT run");

  // Verify the on-disk script is now v2
  const onDisk = readFileSync(fixtureScript, "utf8");
  assert(onDisk.includes("[sitey-updater-v2]"), "on-disk script is now v2");

  // Restore original for next scenario
  writeFileSync(fixtureScript, origScript);
}

function scenario3_scriptDeletion(): void {
  console.log("\n── Scenario 3: Script deletion (rename simulation) ──");

  const token = randomToken();
  writeFileSync(markerFile, token);

  // Save to temp, delete from disk, run saved copy
  updaterExecRaw(`cp ${SCRIPT_PATH} /tmp/v1.sh`);
  updaterExecRaw(`rm ${SCRIPT_PATH}`);
  updaterExec("sh /tmp/v1.sh");

  const log = readLog();

  assert(
    log.includes("=== update complete ==="),
    "update completed despite script deletion",
  );

  // Restore for cleanup
  copyFileSync(realScript, fixtureScript);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

try {
  setup();
  scenario1_basicUpdate();
  scenario2_scriptSelfReplacement();
  scenario3_scriptDeletion();
  console.log("\n✅ All scenarios passed\n");
} catch (e) {
  const log = readLog();
  if (log) {
    console.error("\nUpdate log:");
    console.error(log);
  }
  console.error("\n❌ Test failed:", (e as Error).message);
  process.exit(1);
} finally {
  teardown();
}
