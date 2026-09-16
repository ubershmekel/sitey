import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parse } from "yaml";
import { docker, runOrReplaceContainer } from "../src/services/docker.ts";
import { removeLegacyPortBindings } from "../src/services/portPolicy.ts";
import { db } from "../src/lib/db.ts";
import type { Service } from "../src/generated/prisma/client.ts";

test("runtime containers never publish ports, including legacy hostPort settings", async (t) => {
  const configs: any[] = [];
  t.mock.method(docker, "getContainer", () => ({
    inspect: async () => {
      throw { statusCode: 404 };
    },
  }));
  t.mock.method(docker, "createContainer", async (config: any) => {
    configs.push(config);
    return { id: "new", start: async () => {} };
  });
  for (const hostPort of [null, 20000]) {
    await runOrReplaceContainer({
      service: { id: 42, hostPort, containerPort: 3000 } as Service,
      containerName: "sitey-service-42",
      imageTag: "fixture",
      envVars: {},
      onLog: () => {},
    });
  }
  for (const config of configs) {
    assert.deepEqual(config.HostConfig.PortBindings, {});
    assert.equal(config.HostConfig.PublishAllPorts, false);
    assert.equal(config.HostConfig.NetworkMode, "sitey-public");
  }
});

test("upgrade recreates published containers without rebuilding or removing data", async (t) => {
  const events: string[] = [];
  let config: any;
  let saved: any;
  t.mock.method(docker, "listContainers", async () => [
    { Id: "old", Names: ["/sitey-service-42"] },
  ]);
  const originals = {
    findUnique: db.service.findUnique,
    update: db.service.update,
    updateMany: db.service.updateMany,
  };
  db.service.findUnique = (async () => ({
    id: 42,
    active: true,
    protected: false,
  })) as any;
  db.service.update = (async (args: any) => {
    saved = args.data;
  }) as any;
  db.service.updateMany = (async () => ({ count: 1 })) as any;
  t.after(() => {
    Object.assign(db.service, originals);
  });
  t.mock.method(docker, "getContainer", () => ({
    inspect: async () => ({
      Image: "sha256:existing-image",
      Config: { Env: ["KEY=value"], Cmd: ["node", "app.js"] },
      State: { Running: true },
      HostConfig: {
        PortBindings: {
          "3000/tcp": [{ HostIp: "0.0.0.0", HostPort: "20000" }],
        },
        Binds: ["sitey-data-42:/data"],
        RestartPolicy: { Name: "unless-stopped" },
      },
    }),
    update: async () => {
      events.push("disable-restart");
    },
    stop: async () => {
      events.push("stop");
    },
    remove: async (opts: any) => {
      assert.ok(!opts?.v);
      events.push("remove");
    },
  }));
  t.mock.method(docker, "createContainer", async (input: any) => {
    config = input;
    events.push("create");
    return {
      id: "new",
      start: async () => {
        events.push("start");
      },
    };
  });
  await removeLegacyPortBindings();
  assert.deepEqual(events, [
    "disable-restart",
    "stop",
    "remove",
    "create",
    "start",
  ]);
  assert.deepEqual(config.HostConfig.PortBindings, {});
  assert.deepEqual(config.HostConfig.Binds, ["sitey-data-42:/data"]);
  assert.equal(config.Image, "sha256:existing-image");
  assert.deepEqual(config.Env, ["KEY=value"]);
  assert.equal(saved.hostPort, null);
  assert.equal(saved.containerId, "new");
});

test("production admin socket is mounted only into Caddy and the API", () => {
  const config = parse(
    fs.readFileSync(
      new URL("../../deploy/docker-compose.yml", import.meta.url),
      "utf8",
    ),
  );
  const holders = Object.entries(config.services)
    .filter(([, s]: [string, any]) =>
      s.volumes?.includes("caddy_admin:/run/caddy-admin"),
    )
    .map(([name]) => name)
    .sort();
  assert.deepEqual(holders, ["caddy", "sitey-api"]);
  assert.deepEqual(config.services.caddy.ports, ["80:80", "443:443"]);
  assert.equal(
    config.services["sitey-api"].environment.CADDY_ADMIN_SOCKET,
    "/run/caddy-admin/admin.sock",
  );
  const bootstrap = fs.readFileSync(
    new URL("../../deploy/caddy/Caddyfile", import.meta.url),
    "utf8",
  );
  assert.match(bootstrap, /admin unix\/\/run\/caddy-admin\/admin.sock/);
  assert.doesNotMatch(bootstrap, /admin 0\.0\.0\.0/);
});
