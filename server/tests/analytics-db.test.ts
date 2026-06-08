import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Point the analytics DB at a throwaway file BEFORE importing the modules that
// read ANALYTICS_DB_PATH at load time. Static imports hoist, so we use dynamic
// imports after setting the env var.
const tmpDb = path.join(os.tmpdir(), `sitey-analytics-test-${Date.now()}.db`);
process.env.ANALYTICS_DB_PATH = tmpDb;

const { getAnalyticsDb } = await import("../src/lib/analyticsDb.ts");
const { ingestLinesForTest } =
  await import("../src/services/analytics/ingest.ts");
const { runPrune } = await import("../src/services/analytics/prune.ts");
const { utcDayNumber } = await import("../src/services/analytics/time.ts");

function cleanup() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(tmpDb + suffix);
    } catch {
      // ignore
    }
  }
}

function line(o: Record<string, unknown>): string {
  return JSON.stringify({
    ts: Math.floor(Date.now() / 1000),
    service_id: 1,
    status: 200,
    size: 100,
    request: { host: "x.test", method: "GET", uri: "/" },
    resp_headers: { "Content-Type": ["text/html"] },
    ...o,
  });
}

test("ingest folds lines into request + rollup counters", () => {
  const db = getAnalyticsDb();

  const n = ingestLinesForTest([
    line({ request: { host: "x.test", uri: "/a" } }),
    line({ request: { host: "x.test", uri: "/a" } }),
    line({ status: 500, request: { host: "x.test", uri: "/b" }, size: 50 }),
    line({ service_id: 0, request: { host: "x.test", uri: "/admin" } }),
  ]);
  assert.equal(n, 4);

  // request tier
  const reqCount = (
    db.prepare("SELECT count(*) c FROM request").get() as { c: number }
  ).c;
  assert.equal(reqCount, 4);

  // total tier: service 1 saw 3 requests, 1 error (the 5xx), 250 bytes
  const total = db
    .prepare("SELECT requests, errors, bytes FROM total WHERE service_id = 1")
    .get() as { requests: number; errors: number; bytes: number };
  assert.equal(total.requests, 3);
  assert.equal(total.errors, 1);
  assert.equal(total.bytes, 250);

  // admin panel rolled up separately under service_id 0
  const admin = db
    .prepare("SELECT requests FROM total WHERE service_id = 0")
    .get() as { requests: number };
  assert.equal(admin.requests, 1);

  // daily upsert accumulated for today
  const daily = db
    .prepare(
      "SELECT requests, errors FROM daily WHERE service_id = 1 AND day = ?",
    )
    .get(utcDayNumber(Math.floor(Date.now() / 1000))) as {
    requests: number;
    errors: number;
  };
  assert.equal(daily.requests, 3);
  assert.equal(daily.errors, 1);

  cleanup();
});

test("untagged lines are bucketed, never dropped", () => {
  const db = getAnalyticsDb();

  // A line with no service_id at all, and one with a non-numeric service_id —
  // both must be ingested (not dropped) and roll up under UNKNOWN_SERVICE_ID (0).
  const noId = JSON.stringify({
    ts: Math.floor(Date.now() / 1000),
    status: 404,
    size: 0,
    request: { host: "u.test", method: "GET", uri: "/js/x.js" },
  });
  const badId = JSON.stringify({
    ts: Math.floor(Date.now() / 1000),
    service_id: "not-a-number",
    status: 404,
    size: 0,
    request: { host: "u.test", method: "GET", uri: "/js/y.js" },
  });

  const n = ingestLinesForTest([noId, badId]);
  assert.equal(n, 2); // both parsed, neither dropped

  // Both landed under service_id 0 (the "unknown" bucket). Assert on this test's
  // own paths — the singleton DB connection persists across tests, so a raw
  // count on service_id 0 would also include test 1's admin line.
  const unknown = db
    .prepare(
      "SELECT count(*) c FROM request WHERE service_id = 0 AND path IN ('/js/x.js', '/js/y.js')",
    )
    .get() as { c: number };
  assert.equal(unknown.c, 2);

  cleanup();
});

test("prune drops old request rows but keeps rollups", () => {
  const db = getAnalyticsDb();
  const old = Math.floor(Date.now() / 1000) - 30 * 86400; // 30 days ago

  ingestLinesForTest([
    line({ ts: old, service_id: 5, request: { host: "x", uri: "/old" } }),
  ]);

  assert.equal(
    (
      db
        .prepare("SELECT count(*) c FROM request WHERE service_id = 5")
        .get() as { c: number }
    ).c,
    1,
  );

  runPrune();

  // request row pruned (older than 7 days) ...
  assert.equal(
    (
      db
        .prepare("SELECT count(*) c FROM request WHERE service_id = 5")
        .get() as { c: number }
    ).c,
    0,
  );
  // ... but the total counter survives.
  assert.equal(
    (
      db.prepare("SELECT requests FROM total WHERE service_id = 5").get() as {
        requests: number;
      }
    ).requests,
    1,
  );

  cleanup();
});
