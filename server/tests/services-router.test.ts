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
process.env.DATA_ROOT = dir;
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
const { caddyReloader, buildCaddyfile, caddyAdapter } =
  await import("../src/services/caddy.ts");
const { CaddyRejectedError } = await import("../src/services/caddyAdmin.ts");
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
  assert.deepEqual(renamed, { id: app.id, name: "renamed", warning: null });
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

test("concurrent adds for one effective host/path yield one route and a clean conflict", async () => {
  const a = await service("race-a"),
    b = await service("race-b");
  const wildcard = await db.domain.create({
    data: {
      hostname: "*.example.com",
      letsEncryptEmail: "",
      siteySubdomainsEnabled: false,
    },
  });
  const exact = await db.domain.create({
    data: { hostname: "app.example.com", letsEncryptEmail: "" },
  });
  // Same effective hostname through two different Domain rows, so the unique
  // index can't catch it; only the serialized transaction check can.
  const results = await Promise.allSettled([
    caller.addRoute({
      serviceId: a.id,
      domainId: wildcard.id,
      subdomain: "app",
      httpOnly: true,
    }),
    caller.addRoute({ serviceId: b.id, domainId: exact.id, httpOnly: true }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = results.find((r) => r.status === "rejected");
  assert.match(String(rejected?.reason), /already routed/);
  assert.equal(await db.serviceRoute.count(), 1);

  // Domainless routes have a NULL domainId, which the unique index ignores.
  const pathOnly = await Promise.allSettled([
    caller.addRoute({ serviceId: a.id, pathPrefix: "/shared" }),
    caller.addRoute({ serviceId: b.id, pathPrefix: "/shared" }),
    caller.addRoute({ serviceId: a.id, pathPrefix: "/shared" }),
  ]);
  assert.equal(await db.serviceRoute.count({ where: { domainId: null } }), 1);
  assert.equal(pathOnly.filter((r) => r.status === "rejected").length, 1);
});

test("static routing defaults to spa and is visible through describe", async () => {
  const created = await caller.create({
    name: "examplesite",
    repoOwner: "owner",
    repoName: "repo",
    deployMode: "static",
  });
  const view = await caller.describe({ id: created.id });
  assert.equal(view.staticRoutingMode, "spa");
  assert.equal(view.staticCaddyConfig, "");
  const multi = await caller.create({
    name: "docs",
    repoOwner: "owner",
    repoName: "repo",
    deployMode: "static",
    staticRoutingMode: "multi-page",
  });
  assert.equal(
    (await caller.describe({ id: multi.id })).staticRoutingMode,
    "multi-page",
  );
});

test("routing changes reload Caddy immediately without a deploy", async () => {
  const app = await service("site");
  let reloads = 0;
  let enqueued = 0;
  mock.method(caddyReloader, "reload", async () => {
    reloads++;
  });
  mock.method(deployQueue, "enqueue", () => {
    enqueued++;
  });
  const result = await caller.update({
    id: app.id,
    staticRoutingMode: "multi-page",
  });
  assert.equal(result.warning, null);
  assert.equal(reloads, 1);
  assert.equal(enqueued, 0);
  // Build settings alone don't touch Caddy.
  await caller.update({ id: app.id, buildCommand: "npm run build" });
  assert.equal(reloads, 1);
  // A failed reload is reported, and the setting is still saved.
  mock.method(caddyReloader, "reload", async () => {
    throw new Error("caddy down");
  });
  const failed = await caller.update({ id: app.id, staticRoutingMode: "spa" });
  assert.match(failed.warning!, /caddy down/);
  assert.equal(
    (await caller.describe({ id: app.id })).staticRoutingMode,
    "spa",
  );
  // Repeating the same saved values must retry the failed delivery.
  mock.method(caddyReloader, "reload", async () => {
    reloads++;
  });
  const retried = await caller.update({ id: app.id, staticRoutingMode: "spa" });
  assert.equal(retried.warning, null);
  assert.equal(reloads, 2);
});

test("output folder edits apply immediately and warn without blocking saves", async () => {
  const app = await service("folder");
  await db.domain.create({
    data: { hostname: "folder.example.com", letsEncryptEmail: "" },
  });
  const repoPath = path.join(dir, "services", String(app.id), "repo");
  fs.mkdirSync(path.join(repoPath, "dist"), { recursive: true });
  await caller.addRoute({
    serviceId: app.id,
    host: "http://folder.example.com",
  });
  let reloads = 0;
  let config = "";
  mock.method(caddyReloader, "reload", async () => {
    reloads++;
    config = await buildCaddyfile();
  });
  const missing = await caller.update({ id: app.id, outputDir: "dsit" });
  assert.match(missing.outputDirectoryWarning!, /dsit.*does not exist/);
  assert.equal(missing.warning, null);
  assert.match(config, /\/repo\/dsit/);
  const corrected = await caller.update({ id: app.id, outputDir: "dist" });
  assert.equal(corrected.outputDirectoryWarning, undefined);
  assert.match(config, /\/repo\/dist/);
  const mixed = await caller.update({
    id: app.id,
    outputDir: "dist",
    staticRoutingMode: "multi-page",
  });
  assert.equal(mixed.outputDirectoryWarning, undefined);
  assert.match(config, /@sitey_page/);
  fs.writeFileSync(path.join(repoPath, "file.txt"), "not a directory");
  const notDirectory = await caller.update({
    id: app.id,
    outputDir: "file.txt",
  });
  assert.match(notDirectory.outputDirectoryWarning!, /not a directory/);
  const root = await caller.update({ id: app.id, outputDir: "" });
  assert.equal(root.outputDirectoryWarning, undefined);
  assert.equal(reloads, 5);
  mock.method(caddyReloader, "reload", async () => {
    throw new Error("offline");
  });
  const failed = await caller.update({ id: app.id, outputDir: "dist" });
  assert.match(failed.warning!, /offline/);
  mock.method(caddyReloader, "reload", async () => {
    reloads++;
  });
  await caller.update({ id: app.id, outputDir: "dist" });
  assert.equal(reloads, 6);
});

test("output folders that would break the Caddyfile or leave the repo are rejected", async () => {
  const app = await service("badfolder");
  let reloads = 0;
  mock.method(caddyReloader, "reload", async () => {
    reloads++;
  });
  for (const outputDir of [
    "dist}",
    "{dist",
    "dist\nimport x",
    '"dist"',
    "dist\\build",
    "..",
    "../other",
    "dist/../..",
    "/etc",
  ]) {
    await assert.rejects(
      caller.update({ id: app.id, outputDir }),
      /Output directory must be/,
      JSON.stringify(outputDir),
    );
    await assert.rejects(
      caller.create({
        name: "badfolder-new",
        repoOwner: "owner",
        repoName: "repo",
        deployMode: "static",
        outputDir,
      }),
      /Output directory must be/,
      JSON.stringify(outputDir),
    );
  }
  assert.equal(reloads, 0);
  assert.equal(
    (await db.service.findUnique({ where: { id: app.id } }))!.outputDir,
    app.outputDir,
  );
  for (const outputDir of [
    "",
    "dist",
    "./dist",
    "dist/",
    "build/.output",
    "a_b-c/d.e",
    "my site",
  ]) {
    await caller.update({ id: app.id, outputDir });
  }
  // Spaces are safe because the root path is a quoted Caddyfile token.
  await db.domain.create({
    data: { hostname: "badfolder.example.com", letsEncryptEmail: "" },
  });
  await caller.addRoute({
    serviceId: app.id,
    host: "http://badfolder.example.com",
  });
  assert.ok(
    (await buildCaddyfile()).includes(
      `root * "/srv/services/${app.id}/repo/my site"`,
    ),
  );
});

test("custom Caddy is validated before it is saved or applied", async () => {
  await db.domain.create({
    data: { hostname: "site.example.com", letsEncryptEmail: "" },
  });
  await db.domain.create({
    data: { hostname: "other.example.com", letsEncryptEmail: "" },
  });
  const app = await service("custom");
  const other = await service("other");
  await caller.addRoute({ serviceId: app.id, host: "http://site.example.com" });
  await caller.addRoute({
    serviceId: other.id,
    host: "http://other.example.com",
  });
  const before = await buildCaddyfile();

  let reloads = 0;
  let adapts = 0;
  mock.method(caddyReloader, "reload", async () => {
    reloads++;
  });
  mock.method(caddyAdapter, "adapt", async () => {
    adapts++;
    throw new CaddyRejectedError(
      'Caddy adapt failed (400): {"error":"wrong argument count, at Caddyfile:6"}',
    );
  });

  // Rejected by Caddy: nothing stored, nothing reloaded.
  await assert.rejects(
    caller.update({
      id: app.id,
      staticRoutingMode: "caddy",
      staticCaddyConfig: "redir",
    }),
    /Caddy rejected the custom config: wrong argument count, at line 1\. Nothing was saved\./,
  );
  // Escaping the service's block never even reaches Caddy.
  await assert.rejects(
    caller.update({
      id: app.id,
      staticRoutingMode: "caddy",
      staticCaddyConfig:
        "file_server\n}\nother.example.com {\n    respond hijacked\n",
    }),
    /unmatched closing brace/,
  );
  // A config needs caddy mode, and caddy mode needs a config.
  await assert.rejects(
    caller.update({ id: app.id, staticCaddyConfig: "file_server" }),
    /only applies with staticRoutingMode "caddy"/,
  );
  await assert.rejects(
    caller.update({ id: app.id, staticRoutingMode: "caddy" }),
    /empty/,
  );
  // An unreachable Caddy can't vouch for the config either.
  mock.method(caddyAdapter, "adapt", async () => {
    adapts++;
    throw new TypeError("fetch failed");
  });
  await assert.rejects(
    caller.update({
      id: app.id,
      staticRoutingMode: "caddy",
      staticCaddyConfig: "file_server",
    }),
    (err: { code?: string }) => err.code === "PRECONDITION_FAILED",
  );
  assert.equal(adapts, 2);
  assert.equal(reloads, 0);
  const stored = await db.service.findUniqueOrThrow({ where: { id: app.id } });
  assert.equal(stored.staticRoutingMode, "spa");
  assert.equal(stored.staticCaddyConfig, "");
  assert.equal(await buildCaddyfile(), before);

  // A valid fragment is saved, applied, and stays inside its own site.
  mock.method(caddyAdapter, "adapt", async () =>
    JSON.stringify({ host: ["sitey-validate.invalid"] }).replace(
      /^\{|\}$/g,
      "",
    ),
  );
  const saved = await caller.update({
    id: app.id,
    staticRoutingMode: "caddy",
    staticCaddyConfig: 'header X-Custom "yes"\nfile_server',
  });
  assert.equal(saved.warning, null);
  assert.equal(reloads, 1);
  const config = await buildCaddyfile();
  const block = (caddyfile: string, host: string) => {
    const start = caddyfile.indexOf(`\n${host} {`);
    assert.ok(start >= 0, host);
    return caddyfile.slice(start, caddyfile.indexOf("\n}\n", start));
  };
  assert.match(
    block(config, "http://site.example.com"),
    /root \* "\/srv\/services\/\d+\/repo"\n\s+header X-Custom "yes"\n\s+file_server\n {4}\}$/,
  );
  // The other service's site is byte-for-byte what it was.
  assert.equal(
    block(config, "http://other.example.com"),
    block(before, "http://other.example.com"),
  );

  // Switching modes keeps the stored fragment without revalidating it.
  mock.method(caddyAdapter, "adapt", async () => {
    throw new Error("should not validate");
  });
  await caller.update({ id: app.id, staticRoutingMode: "multi-page" });
  const view = await caller.describe({ id: app.id });
  assert.equal(view.staticRoutingMode, "multi-page");
  assert.equal(view.staticCaddyConfig, 'header X-Custom "yes"\nfile_server');
});
