import { test, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { systemRouter } from "../src/routers/system.ts";
import { caddyReloader } from "../src/services/caddy.ts";
import type { Context } from "../src/context.ts";

const ctx = {
  user: { sub: "test", email: "test@example.com", mustChangePassword: false },
  req: {},
  res: {},
} as Context;
afterEach(() => mock.restoreAll());

test("manual refresh waits for delivery and returns the applied config", async () => {
  let finish!: () => void;
  const delivered = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const reload = mock.method(caddyReloader, "reload", () => delivered);
  let complete = false;
  const request = systemRouter
    .createCaller(ctx)
    .refreshCaddy()
    .then((result) => {
      complete = true;
      return result;
    });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reload.mock.callCount(), 1);
  assert.equal(complete, false);
  finish();
  assert.deepEqual(await request, {
    caddyfile: caddyReloader.lastPushedCaddyfile,
    pushedAt: caddyReloader.lastPushedAt?.toISOString() ?? null,
  });
});

test("manual refresh surfaces delivery errors and can be retried", async () => {
  const caller = systemRouter.createCaller(ctx);
  mock.method(caddyReloader, "reload", async () => {
    throw new Error("Caddy offline");
  });
  await assert.rejects(
    caller.refreshCaddy(),
    /Caddy refresh failed: Caddy offline/,
  );
  const reload = mock.method(caddyReloader, "reload", async () => {});
  await caller.refreshCaddy();
  assert.equal(reload.mock.callCount(), 1);
});

test("manual refresh requires an authenticated user with a changed password", async () => {
  const reload = mock.method(caddyReloader, "reload", async () => {});
  await assert.rejects(
    systemRouter.createCaller({ ...ctx, user: null }).refreshCaddy(),
    { code: "UNAUTHORIZED" },
  );
  await assert.rejects(
    systemRouter
      .createCaller({
        ...ctx,
        user: { ...ctx.user!, mustChangePassword: true },
      })
      .refreshCaddy(),
    { code: "FORBIDDEN" },
  );
  assert.equal(reload.mock.callCount(), 0);
});
