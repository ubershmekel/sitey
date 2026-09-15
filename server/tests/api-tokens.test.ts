import { test } from "node:test";
import assert from "node:assert/strict";
import {
  authenticateToken,
  readBearerToken,
  type TokenStore,
} from "../src/services/apiTokens.ts";
import { hashToken } from "../src/services/crypto.ts";

const user = { id: "u1", email: "me@example.com", mustChangePassword: false };
const NOW = new Date("2026-06-01T00:00:00Z");

type Row = { id: string; type: string; expiresAt: Date | null };

function store(rows: Record<string, Row>) {
  const removed: string[] = [];
  const touched: string[] = [];
  const byHash = new Map(
    Object.entries(rows).map(([raw, row]) => [hashToken(raw), row]),
  );
  const s: TokenStore = {
    findByHash: async (hash) => {
      const row = byHash.get(hash);
      return row ? { ...row, user } : null;
    },
    remove: async (id) => removed.push(id),
    touch: async (id) => touched.push(id),
  };
  return { s, removed, touched };
}

const tokens = {
  apikey: { id: "k1", type: "apikey", expiresAt: null },
  session: {
    id: "s1",
    type: "session",
    expiresAt: new Date("2026-07-01T00:00:00Z"),
  },
  expiredKey: {
    id: "k2",
    type: "apikey",
    expiresAt: new Date("2026-05-01T00:00:00Z"),
  },
};

test("readBearerToken parses only well-formed bearer headers", () => {
  assert.equal(readBearerToken("Bearer abc"), "abc");
  assert.equal(readBearerToken("bearer abc "), "abc");
  assert.equal(readBearerToken("Basic abc"), null);
  assert.equal(readBearerToken("Bearer"), null);
  assert.equal(readBearerToken("Bearer a b"), null);
  assert.equal(readBearerToken(undefined), null);
});

test("bearer accepts an API key and updates lastUsedAt", async () => {
  const { s, touched } = store({ apikey: tokens.apikey });
  const result = await authenticateToken("apikey", "bearer", s, NOW);
  assert.deepEqual(result, {
    sub: "u1",
    email: "me@example.com",
    mustChangePassword: false,
  });
  assert.deepEqual(touched, ["k1"]);
});

test("bearer rejects unknown tokens", async () => {
  const { s } = store({ apikey: tokens.apikey });
  assert.equal(await authenticateToken("nope", "bearer", s, NOW), null);
});

test("bearer rejects revoked (deleted) tokens", async () => {
  const { s } = store({});
  assert.equal(await authenticateToken("apikey", "bearer", s, NOW), null);
});

test("bearer rejects expired API keys and cleans them up", async () => {
  const { s, removed, touched } = store({ expired: tokens.expiredKey });
  assert.equal(await authenticateToken("expired", "bearer", s, NOW), null);
  assert.deepEqual(removed, ["k2"]);
  assert.deepEqual(touched, []);
});

test("bearer rejects session tokens", async () => {
  const { s, touched } = store({ session: tokens.session });
  assert.equal(await authenticateToken("session", "bearer", s, NOW), null);
  assert.deepEqual(touched, []);
});

test("cookie accepts sessions but rejects API keys", async () => {
  const { s } = store({ session: tokens.session, apikey: tokens.apikey });
  assert.ok(await authenticateToken("session", "cookie", s, NOW));
  assert.equal(await authenticateToken("apikey", "cookie", s, NOW), null);
});
