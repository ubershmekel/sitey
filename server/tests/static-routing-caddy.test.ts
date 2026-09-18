/**
 * Serves generated static routes from a real Caddy (caddy:alpine in Docker)
 * and checks the HTTP behavior of each routing mode. Skipped when Docker isn't
 * available.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const PORT = 18090 + (process.pid % 500);
const ADMIN_PORT = PORT + 1;
const NAME = `sitey-static-routing-test-${process.pid}`;
const dockerAvailable =
  !process.env.SITEY_SKIP_DOCKER_TESTS &&
  spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

// caddy.ts reads the admin URL at import time. Caddy checks the Origin
// against its own listen address, not the published port.
process.env.CADDY_ADMIN_URL = `http://127.0.0.1:${ADMIN_PORT}`;
process.env.CADDY_ADMIN_ORIGIN = "http://0.0.0.0:2019";
const { appendRouteHandler, validateStaticCaddyConfig } =
  await import("../src/services/caddy.ts");
type Route = Parameters<typeof appendRouteHandler>[1];

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sitey-caddy-"));

function write(rel: string, body: string) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function route(
  id: number,
  pathPrefix: string,
  staticRoutingMode: string,
  staticCaddyConfig = "",
): Route {
  return {
    subdomain: "",
    pathPrefix,
    httpOnly: true,
    service: {
      id,
      deployMode: "static",
      status: "running",
      hasSuccessfulDeployment: true,
      outputDir: "dist",
      containerName: null,
      containerPort: 0,
      staticRoutingMode,
      staticCaddyConfig,
    },
  };
}

const CUSTOM = `@legacy path /old/*
redir @legacy /new{uri} 308

header /assets/* Cache-Control "public, max-age=31536000, immutable"

try_files {path} {path}/index.html {path}.html =404
file_server
`;

// One site per host, like buildCaddyConfig: the pages.test host mixes a
// catch-all with a path-prefixed service to prove their 404s stay separate.
const SITES: Record<string, Route[]> = {
  "spa.test": [route(1, "", "spa")],
  "pages.test": [route(3, "/docs", "multi-page"), route(2, "", "multi-page")],
  "custom.test": [route(4, "", "caddy", CUSTOM)],
};

/** node:http, because fetch doesn't let a request set its Host header. */
function get(host: string, urlPath: string) {
  return new Promise<{
    status: number;
    body: string;
    location: string | null;
    headers: http.IncomingHttpHeaders;
  }>((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port: PORT, path: urlPath, headers: { Host: host } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: body.trim(),
            location: (res.headers.location as string | undefined) ?? null,
            headers: res.headers,
          }),
        );
      },
    );
    req.on("error", reject);
  });
}

before(async () => {
  if (!dockerAvailable) return;
  // Service 1: an SPA. Service 2: a multi-page site with 404.html.
  // Service 3: a multi-page site without one. Service 4: custom Caddy.
  write("1/repo/dist/index.html", "spa-home");
  write("1/repo/dist/app.js", "spa-asset");
  write("2/repo/dist/index.html", "home");
  write("2/repo/dist/privacy.html", "privacy-file");
  write("2/repo/dist/terms/index.html", "terms-dir");
  write("2/repo/dist/404.html", "custom-404");
  write("3/repo/dist/index.html", "docs-home");
  write("3/repo/dist/guide.html", "docs-guide");
  write("4/repo/dist/index.html", "custom-home");
  write("4/repo/dist/new/page.html", "moved");
  write("4/repo/dist/assets/app.css", "css");

  const lines = ["{", "    admin 0.0.0.0:2019", "}", ""];
  for (const [host, routes] of Object.entries(SITES)) {
    lines.push(`http://${host} {`);
    for (const r of routes) appendRouteHandler(lines, r);
    lines.push("}", "");
  }
  fs.writeFileSync(path.join(root, "Caddyfile"), lines.join("\n"));

  execFileSync(
    "docker",
    [
      "run",
      "-d",
      "--rm",
      "--name",
      NAME,
      "-p",
      `127.0.0.1:${PORT}:80`,
      "-p",
      `127.0.0.1:${ADMIN_PORT}:2019`,
      "-v",
      `${root}:/srv/services:ro`,
      "-v",
      `${path.join(root, "Caddyfile")}:/etc/caddy/Caddyfile:ro`,
      "caddy:alpine",
    ],
    { stdio: "pipe" },
  );
  for (let i = 0; i < 100; i++) {
    try {
      await get("spa.test", "/");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const logs = spawnSync("docker", ["logs", NAME], { encoding: "utf8" });
  throw new Error(`Caddy didn't start:\n${logs.stdout}${logs.stderr}`);
});

after(() => {
  if (dockerAvailable)
    spawnSync("docker", ["rm", "-f", NAME], { stdio: "ignore" });
  fs.rmSync(root, { recursive: true, force: true });
});

const docker = { skip: !dockerAvailable && "Docker isn't available" };

test(
  "spa: assets are served and unknown paths return index.html",
  docker,
  async () => {
    assert.deepEqual(
      [
        (await get("spa.test", "/app.js")).body,
        (await get("spa.test", "/")).body,
      ],
      ["spa-asset", "spa-home"],
    );
    const unknown = await get("spa.test", "/privacy/");
    assert.equal(unknown.status, 200);
    assert.equal(unknown.body, "spa-home");
  },
);

test(
  "multi-page: clean URLs, directory indexes and a real 404",
  docker,
  async () => {
    const cases: [string, number, string][] = [
      ["/", 200, "home"],
      ["/privacy", 200, "privacy-file"],
      ["/privacy.html", 200, "privacy-file"],
      ["/terms", 200, "terms-dir"],
      ["/terms/", 200, "terms-dir"],
      ["/missing", 404, "custom-404"],
      ["/missing/deep/", 404, "custom-404"],
    ];
    for (const [urlPath, status, body] of cases) {
      const res = await get("pages.test", urlPath);
      assert.deepEqual([res.status, res.body], [status, body], urlPath);
      assert.equal(res.headers["x-sitey-service"], "2", urlPath);
    }
  },
);

test(
  "multi-page under a path prefix uses its own files and 404",
  docker,
  async () => {
    assert.equal((await get("pages.test", "/docs")).status, 308);
    assert.equal((await get("pages.test", "/docs/")).body, "docs-home");
    assert.equal((await get("pages.test", "/docs/guide")).body, "docs-guide");
    // Service 3 has no 404.html: a plain 404, never service 2's page.
    const missing = await get("pages.test", "/docs/privacy");
    assert.deepEqual([missing.status, missing.body], [404, ""]);
    assert.equal(missing.headers["x-sitey-service"], "3");
  },
);

test(
  "custom Caddy directives run inside the service's site",
  docker,
  async () => {
    const moved = await get("custom.test", "/old/page");
    assert.deepEqual([moved.status, moved.location], [308, "/new/old/page"]);
    assert.equal((await get("custom.test", "/new/page")).body, "moved");
    const css = await get("custom.test", "/assets/app.css");
    assert.match(String(css.headers["cache-control"]), /immutable/);
    assert.equal(css.headers["x-sitey-service"], "4");
    assert.equal((await get("custom.test", "/nope")).status, 404);
    // Other sites are untouched by service 4's directives.
    assert.equal((await get("spa.test", "/old/x")).body, "spa-home");
  },
);

test(
  "Caddy's adapter accepts valid fragments and rejects invalid ones",
  docker,
  async () => {
    assert.deepEqual(
      await validateStaticCaddyConfig(CUSTOM, { id: 4, outputDir: "dist" }),
      { ok: true },
    );
    const bad = await validateStaticCaddyConfig(
      "file_server {\n    nonsense 1\n}",
      {
        id: 4,
        outputDir: "dist",
      },
    );
    assert.equal(bad.ok, false);
    assert.match(
      !bad.ok ? bad.message : "",
      /unknown subdirective 'nonsense'.*line 2/,
    );
  },
);
