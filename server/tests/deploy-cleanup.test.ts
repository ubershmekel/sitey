import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildKeepTags,
  parseRollbackCount,
} from "../src/services/deployment.ts";

// ── parseRollbackCount ────────────────────────────────────────────────────────

const rollbackCountCases: Array<[input: string | undefined, expected: number]> =
  [
    [undefined, 1], // missing config → default 1
    ["1", 1],
    ["3", 3],
    ["0", 0],
    ["-1", 0], // negative → clamped to 0
    ["-99", 0],
    ["abc", 0], // non-numeric → 0
    ["", 0],
  ];

for (const [input, expected] of rollbackCountCases) {
  test(`parseRollbackCount(${JSON.stringify(input)}) === ${expected}`, () => {
    assert.equal(parseRollbackCount(input), expected);
  });
}

// ── buildKeepTags ─────────────────────────────────────────────────────────────
// N is enforced upstream by the DB query (take: n); buildKeepTags receives
// whatever the query returned and prepends the current tag, deduplicating.

const cur = "sitey/1:cur";
const p1 = "sitey/1:p1";
const p2 = "sitey/1:p2";

const keepTagsCases: Array<{
  desc: string;
  current: string;
  previous: string[];
  expected: string[];
}> = [
  {
    desc: "no history → only current",
    current: cur,
    previous: [],
    expected: [cur],
  },
  {
    desc: "one rollback",
    current: cur,
    previous: [p1],
    expected: [cur, p1],
  },
  {
    desc: "two rollbacks",
    current: cur,
    previous: [p1, p2],
    expected: [cur, p1, p2],
  },
  {
    desc: "current is always first",
    current: cur,
    previous: [p1],
    expected: [cur, p1],
  },
  {
    desc: "duplicate SHA (same tag in previous) → deduplicated",
    current: cur,
    previous: [cur, p1], // same SHA re-deployed
    expected: [cur, p1],
  },
];

for (const { desc, current, previous, expected } of keepTagsCases) {
  test(`buildKeepTags: ${desc}`, () => {
    // n=99: large enough that the limit doesn't interfere — these cases test ordering/dedup
    assert.deepEqual(buildKeepTags(current, previous, 99), expected);
  });
}

// ── Retention scenarios ───────────────────────────────────────────────────────
// Simulates the full keep/drop decision for a service with deploy history
// v1 → v2 → v3 (current). The DB query applies take:n before calling
// buildKeepTags, so only the first n items of the history are passed in.

const v1 = "sitey/42:v1";
const v2 = "sitey/42:v2";
const v3 = "sitey/42:v3"; // current

const retentionCases: Array<{
  n: number;
  beforePrune: string[]; // rollback candidates the DB returns (take:n applied upstream)
  afterPrune: string[]; // full expected keep list
}> = [
  { n: 0, beforePrune: [], afterPrune: [v3] },
  { n: 0, beforePrune: [v3, v2, v1], afterPrune: [v3] },
  { n: 1, beforePrune: [v2], afterPrune: [v3, v2] },
  { n: 2, beforePrune: [v2, v1], afterPrune: [v3, v2, v1] },
];

for (const { n, beforePrune, afterPrune } of retentionCases) {
  test(`retention N=${n}`, () => {
    assert.deepEqual(buildKeepTags(v3, beforePrune, n), afterPrune);
  });
}
