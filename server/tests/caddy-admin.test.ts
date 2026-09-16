import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  caddyAdminAddress,
  pushCaddyViaSocket,
} from "../src/services/caddyAdmin.ts";

test("production admin fails closed without a Unix socket", () => {
  const previousMode = process.env.NODE_ENV,
    previousSocket = process.env.CADDY_ADMIN_SOCKET;
  try {
    process.env.NODE_ENV = "production";
    delete process.env.CADDY_ADMIN_SOCKET;
    assert.throws(caddyAdminAddress, /requires CADDY_ADMIN_SOCKET/);
    process.env.CADDY_ADMIN_SOCKET = "/run/caddy-admin/admin.sock";
    assert.equal(caddyAdminAddress(), "unix//run/caddy-admin/admin.sock");
  } finally {
    if (previousMode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousMode;
    if (previousSocket === undefined) delete process.env.CADDY_ADMIN_SOCKET;
    else process.env.CADDY_ADMIN_SOCKET = previousSocket;
  }
});

test("admin transport sends configuration over a socket and propagates failures", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caddy-admin-"));
  const socket =
    process.platform === "win32"
      ? `\\\\.\\pipe\\sitey-caddy-${process.pid}`
      : path.join(dir, "admin.sock");
  const received: string[] = [];
  let status = 200;
  const server = http.createServer(async (req, res) => {
    assert.equal(req.url, "/load");
    assert.equal(req.method, "POST");
    assert.equal(req.headers.host, "localhost");
    let body = "";
    for await (const part of req) body += part;
    received.push(body);
    res.writeHead(status).end(status === 200 ? "ok" : "invalid config");
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    await pushCaddyViaSocket(socket, "config-one");
    status = 400;
    await assert.rejects(
      pushCaddyViaSocket(socket, "config-two"),
      /invalid config/,
    );
    assert.deepEqual(received, ["config-one", "config-two"]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
