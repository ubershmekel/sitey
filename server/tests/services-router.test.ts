import { test, before, beforeEach, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Context } from "../src/context.ts";

// Use the real Prisma store and real router; only external delivery is mocked.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sitey-router-"));
const file = path.join(dir, "test.db");
fs.writeFileSync(file, ""); // Prisma's Windows engine needs an existing file.
process.env.DATABASE_URL = `file:${file.replace(/\\/g, "/")}`;
execSync("npm run db:push", {
  cwd: fileURLToPath(new URL("../", import.meta.url)),
  env: process.env,
  stdio: "pipe",
});
const { db } = await import("../src/lib/db.ts");
const { servicesRouter } = await import("../src/routers/services.ts");
const { caddyReloader, buildCaddyfile } =
  await import("../src/services/caddy.ts");
const { deployQueue } = await import("../src/lib/queue.ts");
const { docker } = await import("../src/services/docker.ts");
const ctx = {
  user: { sub: "test", email: "test@example.com", mustChangePassword: false },
  req: {},
  res: {},
} as Context;
const caller = servicesRouter.createCaller(ctx);
let repoId: number;

before(async () => {
  await db.$connect();
});
beforeEach(async () => {
  mock.restoreAll();
  mock.method(caddyReloader, "reload", async () => {});
  mock.method(deployQueue, "enqueue", () => {});
  mock.method(docker, "listContainers", async () => []);
  await db.service.deleteMany();
  await db.repo.deleteMany();
  await db.domain.deleteMany();
  await db.systemConfig.deleteMany();
  repoId = (
    await db.repo.create({
      data: { name: "fixture", repoOwner: "owner", repoName: "repo" },
    })
  ).id;
});
after(async () => {
  mock.restoreAll();
  await db.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function service(name: string, envVars = "") {
  return db.service.create({
    data: { name, repoId, envVars, deployMode: "static", status: "running" },
  });
}

test("create commits routes before enqueueing and rolls back route conflicts", async () => {
  await db.domain.create({
    data: { hostname: "localhost", letsEncryptEmail: "" },
  });
  let queuedId: number | undefined;
  let routesAtEnqueue = 0;
  mock.method(deployQueue, "enqueue", (job: { serviceId: number }) => {
    queuedId = job.serviceId;
    const connection = new Database(file, { readonly: true });
    routesAtEnqueue = (
      connection
        .prepare(
          "SELECT count(*) AS count FROM ServiceRoute WHERE serviceId = ?",
        )
        .get(job.serviceId) as { count: number }
    ).count;
    connection.close();
  });
  const created = await caller.create({
    name: "first",
    repoOwner: "owner",
    repoName: "repo",
    routes: ["http://localhost/first"],
  });
  assert.equal(queuedId, created.id);
  assert.equal(routesAtEnqueue, 1);
  assert.equal(
    await db.serviceRoute.count({ where: { serviceId: queuedId } }),
    1,
  );
  assert.equal(created.routes[0].route, "http://localhost/first");
  assert.ok(!("envVars" in created));
  queuedId = undefined;
  await assert.rejects(
    caller.create({
      name: "second",
      repoOwner: "owner",
      repoName: "repo",
      routes: ["http://localhost/first"],
    }),
    /already routed/,
  );
  assert.equal(queuedId, undefined);
  assert.equal(await db.service.count({ where: { name: "second" } }), 0);
  assert.equal(await db.deployment.count(), 1);
});

test("canonical routes remain addressable after an exact domain is added", async () => {
  const a = await service("first"),
    b = await service("second");
  const wildcard = await db.domain.create({
    data: {
      hostname: "*.example.com",
      letsEncryptEmail: "",
      siteySubdomainsEnabled: false,
    },
  });
  await caller.addRoute({ serviceId: a.id, host: "http://app.example.com" });
  await db.domain.create({
    data: { hostname: "app.example.com", letsEncryptEmail: "" },
  });
  const check = await caller.checkRoute({ route: "http://app.example.com" });
  assert.equal(check.takenBy?.id, a.id);
  await assert.rejects(
    caller.addRoute({ serviceId: b.id, host: "http://app.example.com" }),
    /already routed/,
  );
  const retry = await caller.addRoute({
    serviceId: a.id,
    host: "http://app.example.com",
  });
  assert.equal(retry.alreadyExisted, true);
  assert.equal(retry.domainId, wildcard.id);
  // Different paths can use different Domain rows, but share one Caddy block.
  await caller.addRoute({
    serviceId: b.id,
    host: "http://app.example.com/api",
  });
  const config = await buildCaddyfile();
  assert.equal(
    (config.match(/^http:\/\/app\.example\.com \{/gm) ?? []).length,
    1,
  );
  assert.match(config, new RegExp(`service_id ${a.id}`));
  assert.match(config, new RegExp(`service_id ${b.id}`));
  await caller.removeRoute({ serviceId: a.id, host: "http://app.example.com" });
  assert.equal(await db.serviceRoute.count({ where: { serviceId: a.id } }), 0);
});

test("preflight and both route input forms reject the management root", async () => {
  const app = await service("app");
  const domain = await db.domain.create({
    data: { hostname: "*.example.com", letsEncryptEmail: "" },
  });
  await assert.rejects(
    caller.checkRoute({ route: "sitey.example.com" }),
    /reserved/,
  );
  await assert.rejects(
    caller.addRoute({ serviceId: app.id, host: "sitey.example.com" }),
    /reserved/,
  );
  await assert.rejects(
    caller.addRoute({
      serviceId: app.id,
      domainId: domain.id,
      subdomain: "sitey",
    }),
    /reserved/,
  );
  assert.equal(await db.serviceRoute.count(), 0);
});

test("concurrent env edits preserve both changes and explicit reads disclose values", async () => {
  const app = await service("env", "EXISTING=old\nREMOVE=gone");
  await Promise.all([
    caller.setEnvVar({ id: app.id, name: "FIRST", value: "one" }),
    caller.setEnvVar({ id: app.id, name: "SECOND", value: "two" }),
    caller.unsetEnvVar({ id: app.id, name: "REMOVE" }),
  ]);
  assert.deepEqual(await caller.envValues({ id: app.id }), {
    EXISTING: "old",
    FIRST: "one",
    SECOND: "two",
  });
  assert.deepEqual(await caller.getEnvVar({ id: app.id, name: "FIRST" }), {
    name: "FIRST",
    value: "one",
  });
  await assert.rejects(
    caller.getEnvVar({ id: app.id, name: "MISSING" }),
    /No environment/,
  );
  const renamed = await caller.update({ id: app.id, name: "renamed" });
  assert.deepEqual(renamed, { id: app.id, name: "renamed" });
  const anonymous = servicesRouter.createCaller({ ...ctx, user: null });
  await assert.rejects(
    anonymous.envValues({ id: app.id }),
    /Not authenticated/,
  );
});

test("route retries repair delivery and surface Caddy errors", async () => {
  const app = await service("retry");
  await db.domain.create({
    data: { hostname: "localhost", letsEncryptEmail: "" },
  });
  let calls = 0;
  mock.method(caddyReloader, "reload", async () => {
    if (++calls === 1) throw new Error("offline");
  });
  const first = await caller.addRoute({
    serviceId: app.id,
    host: "http://localhost/app",
  });
  assert.match(first.warning!, /offline/);
  const retry = await caller.addRoute({
    serviceId: app.id,
    host: "http://localhost/app",
  });
  assert.equal(retry.alreadyExisted, true);
  assert.equal(retry.warning, null);
  assert.equal(calls, 2);
  // The scheme isn't part of route identity; a retry reports the route absent.
  const removed = await caller.removeRoute({
    serviceId: app.id,
    host: "localhost/app",
  });
  assert.equal("alreadyAbsent" in removed, false);
  assert.equal(
    await db.serviceRoute.count({ where: { serviceId: app.id } }),
    0,
  );
  const again = await caller.removeRoute({
    serviceId: app.id,
    host: "http://localhost/app",
  });
  assert.equal("alreadyAbsent" in again && again.alreadyAbsent, true);
  assert.equal(calls, 4);
});
