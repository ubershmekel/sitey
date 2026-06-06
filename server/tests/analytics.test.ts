import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLine } from "../src/services/analytics/ingest.ts";
import { utcDayNumber, isoYearWeek } from "../src/services/analytics/time.ts";

// ── Date helpers ─────────────────────────────────────────────────────────────

test("utcDayNumber yields yyyymmdd in UTC", () => {
  // 2026-06-05T12:00:00Z
  const ts = Date.UTC(2026, 5, 5, 12, 0, 0) / 1000;
  assert.equal(utcDayNumber(ts), 20260605);
});

test("isoYearWeek handles the Dec/Jan boundary", () => {
  // 2026-01-01 is a Thursday → ISO week 2026-W01.
  const jan1 = Date.UTC(2026, 0, 1, 0, 0, 0) / 1000;
  assert.equal(isoYearWeek(jan1), 202601);

  // 2027-01-01 is a Friday → still ISO week 53 of 2026.
  const nextJan1 = Date.UTC(2027, 0, 1, 0, 0, 0) / 1000;
  assert.equal(isoYearWeek(nextJan1), 202653);
});

// ── Line parsing ─────────────────────────────────────────────────────────────

function makeLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ts: 1780000000.123,
    service_id: 42,
    status: 200,
    size: 1234,
    request: {
      host: "Example.COM",
      method: "GET",
      uri: "/blog/post?utm=abc",
    },
    resp_headers: { "Content-Type": ["text/html; charset=utf-8"] },
    ...overrides,
  });
}

test("parseLine extracts and normalizes the request facts", () => {
  const row = parseLine(makeLine());
  assert.ok(row);
  assert.equal(row.ts, 1780000000);
  assert.equal(row.serviceId, 42);
  assert.equal(row.host, "example.com");
  assert.equal(row.path, "/blog/post"); // query stripped
  assert.equal(row.status, 200);
  assert.equal(row.method, "GET");
  assert.equal(row.contentType, "text/html"); // params dropped, lowercased
  assert.equal(row.bytes, 1234);
});

test("parseLine accepts service_id 0 (admin panel)", () => {
  const row = parseLine(makeLine({ service_id: 0 }));
  assert.ok(row);
  assert.equal(row.serviceId, 0);
});

test("parseLine truncates very long paths", () => {
  const longPath = "/" + "a".repeat(500);
  const row = parseLine(makeLine({ request: { host: "x", uri: longPath } }));
  assert.ok(row);
  assert.equal(row.path.length, 128);
});

test("parseLine rejects malformed or untagged lines", () => {
  assert.equal(parseLine(""), null);
  assert.equal(parseLine("not json"), null);
  // missing service_id
  assert.equal(
    parseLine(JSON.stringify({ ts: 1, status: 200, request: {} })),
    null,
  );
  // missing ts
  assert.equal(
    parseLine(JSON.stringify({ service_id: 1, status: 200, request: {} })),
    null,
  );
});
