import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CaddyReloader,
  mergeRenderedSiteBlocks,
} from "../src/services/caddy.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ── single reload ────────────────────────────────────────────────────────────

test("single reload: calls build then push, records result", async () => {
  const reloader = new CaddyReloader({
    build: async () => "cfg-1",
    push: async () => {},
  });
  await reloader.reload();
  assert.equal(reloader.lastPushedCaddyfile, "cfg-1");
  assert.ok(reloader.lastPushedAt instanceof Date);
});

// ── concurrent reloads ───────────────────────────────────────────────────────

test("concurrent reloads: coalesced into one follow-up build+push", async () => {
  const builds: string[] = [];
  const pushes: string[] = [];
  let buildCount = 0;
  const gate = deferred();

  const reloader = new CaddyReloader({
    build: async () => {
      buildCount++;
      const cfg = `cfg-${buildCount}`;
      builds.push(cfg);
      if (buildCount === 1) await gate.promise; // pause first build
      return cfg;
    },
    push: async (cfg) => {
      pushes.push(cfg);
    },
  });

  const r1 = reloader.reload(); // starts, pauses at first build
  void reloader.reload(); // sets reloadQueued = true, returns
  void reloader.reload(); // reloadQueued already true, no-op

  gate.resolve(); // unblock first build
  await r1;

  // Two builds and pushes: one for the original, one for the coalesced queue
  assert.deepEqual(builds, ["cfg-1", "cfg-2"]);
  assert.deepEqual(pushes, ["cfg-1", "cfg-2"]);
  assert.equal(reloader.lastPushedCaddyfile, "cfg-2");
});

// ── error handling ───────────────────────────────────────────────────────────

test("push error: propagates to caller and releases lock", async () => {
  let callCount = 0;
  const reloader = new CaddyReloader({
    build: async () => "cfg",
    push: async () => {
      callCount++;
      if (callCount === 1) throw new Error("push failed");
    },
  });

  await assert.rejects(() => reloader.reload(), /push failed/);

  // Lock must be released — next reload should succeed
  await reloader.reload();
  assert.equal(reloader.lastPushedCaddyfile, "cfg");
});

test("build error: propagates to caller and releases lock", async () => {
  let callCount = 0;
  const reloader = new CaddyReloader({
    build: async () => {
      callCount++;
      if (callCount === 1) throw new Error("build failed");
      return "cfg";
    },
    push: async () => {},
  });

  await assert.rejects(() => reloader.reload(), /build failed/);
  assert.equal(reloader.lastPushedCaddyfile, null); // nothing pushed

  await reloader.reload();
  assert.equal(reloader.lastPushedCaddyfile, "cfg");
});

// ── lastPushedCaddyfile not updated on failure ────────────────────────────────

test("lastPushedCaddyfile stays null after failed push", async () => {
  const reloader = new CaddyReloader({
    build: async () => "cfg",
    push: async () => {
      throw new Error("fail");
    },
  });
  await assert.rejects(() => reloader.reload());
  assert.equal(reloader.lastPushedCaddyfile, null);
  assert.equal(reloader.lastPushedAt, null);
});

test("mergeRenderedSiteBlocks: combines matching blocks into one site label list", () => {
  const merged = mergeRenderedSiteBlocks([
    {
      labels: ["www.redditp.com"],
      bodyLines: ["    root * /srv/services/3/repo", "    file_server"],
    },
    {
      labels: ["redditp.com"],
      bodyLines: ["    root * /srv/services/3/repo", "    file_server"],
    },
    {
      labels: ["vc.redditp.com"],
      bodyLines: ["    reverse_proxy sitey-api:3001"],
      tlsEmail: "ops@example.com",
    },
    {
      labels: ["testing.redditp.com"],
      bodyLines: ["    reverse_proxy sitey-api:3001"],
      tlsEmail: "ops@example.com",
    },
  ]);

  assert.deepEqual(merged, [
    {
      labels: ["www.redditp.com", "redditp.com"],
      bodyLines: ["    root * /srv/services/3/repo", "    file_server"],
      tlsEmail: undefined,
    },
    {
      labels: ["vc.redditp.com", "testing.redditp.com"],
      bodyLines: ["    reverse_proxy sitey-api:3001"],
      tlsEmail: "ops@example.com",
    },
  ]);
});

test("mergeRenderedSiteBlocks: keeps blocks separate when TLS settings differ", () => {
  const merged = mergeRenderedSiteBlocks([
    {
      labels: ["a.example.com"],
      bodyLines: ["    respond 204"],
      tlsEmail: "a@example.com",
    },
    {
      labels: ["b.example.com"],
      bodyLines: ["    respond 204"],
      tlsEmail: "b@example.com",
    },
  ]);

  assert.equal(merged.length, 2);
});
