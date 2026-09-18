import { test, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendRouteHandler,
  caddyAdapter,
  validateStaticCaddyConfig,
  type CaddyServiceRoute,
} from "../src/services/caddy.ts";
import { CaddyRejectedError } from "../src/services/caddyAdmin.ts";
import {
  checkCaddyFragment,
  detectMultiPageOutput,
} from "../src/services/staticRouting.ts";

afterEach(() => mock.restoreAll());

type Svc = NonNullable<CaddyServiceRoute["service"]>;

function render(overrides: Partial<Svc> = {}, pathPrefix = ""): string {
  const lines: string[] = [];
  appendRouteHandler(lines, {
    subdomain: "",
    pathPrefix,
    httpOnly: false,
    service: {
      id: 7,
      deployMode: "static",
      status: "running",
      hasSuccessfulDeployment: true,
      outputDir: "dist",
      containerName: null,
      containerPort: 3000,
      ...overrides,
    },
  });
  return lines.join("\n");
}

const SPEC_EXAMPLE = `@legacy path /old/*
redir @legacy /new{uri} 308

header /assets/* Cache-Control "public, max-age=31536000, immutable"

try_files {path} {path}/index.html {path}.html =404
file_server
`;

test("a service without a routing mode keeps the SPA fallback", () => {
  for (const prefix of ["", "/app"]) {
    const out = render({}, prefix);
    assert.match(
      out,
      /root \* \/srv\/services\/7\/repo\/dist\n\s+try_files \{path\} \/index\.html\n\s+file_server/,
    );
    assert.deepEqual(render({ staticRoutingMode: "spa" }, prefix), out);
  }
});

test("multi-page serves clean URLs and a scoped 404 without handle_errors", () => {
  const out = render({ staticRoutingMode: "multi-page" });
  assert.match(
    out,
    /@sitey_page file \{path\} \{path\}\/index\.html \{path\}\.html/,
  );
  assert.match(out, /@sitey_404 file \/404\.html/);
  assert.match(out, /file_server \{\n\s+status 404/);
  assert.doesNotMatch(out, /handle_errors|try_files \{path\} \/index\.html/);
  // Balanced braces: the preset stays inside the service's handle block.
  assert.equal(out.match(/\{$/gm)?.length, out.match(/^\s*\}$/gm)?.length);
});

test("path-prefix routes keep the prefix redirect and their own root", () => {
  for (const mode of ["spa", "multi-page", "caddy"]) {
    const out = render(
      { staticRoutingMode: mode, staticCaddyConfig: "file_server" },
      "/docs",
    );
    assert.match(out, /handle \/docs \{\n(?:.*\n)*?\s+redir \* \/docs\/ 308/);
    const inner = out.slice(out.indexOf("handle_path /docs/* {"));
    assert.match(inner, /root \* \/srv\/services\/7\/repo\/dist/);
    assert.match(inner, /\n {4}\}$/);
  }
});

test("custom mode places the fragment after Sitey's tags and root", () => {
  const out = render({
    staticRoutingMode: "caddy",
    staticCaddyConfig: SPEC_EXAMPLE,
  });
  const lines = out.split("\n").map((l) => l.trim());
  assert.deepEqual(lines.slice(0, 5), [
    "handle {",
    "log_append service_id 7",
    "header >X-Sitey-Service 7",
    "root * /srv/services/7/repo/dist",
    "@legacy path /old/*",
  ]);
  assert.ok(
    out.includes(
      '        header /assets/* Cache-Control "public, max-age=31536000, immutable"',
    ),
  );
  assert.ok(out.endsWith("        file_server\n    }"));
});

test("a stored fragment that fails the scope check serves an error, not the fragment", () => {
  const out = render({
    staticRoutingMode: "caddy",
    staticCaddyConfig: "}\nevil.com {\n    respond hi\n",
  });
  assert.doesNotMatch(out, /evil\.com/);
  assert.match(
    out,
    /respond "Invalid custom Caddy config for this service" 500/,
  );
});

test("checkCaddyFragment accepts service-scoped routing", () => {
  checkCaddyFragment(SPEC_EXAMPLE);
  checkCaddyFragment(`# comments may mention } and {
encode gzip
@api path /api/*
handle @api {
    respond "not here" 404
}
handle_path /blog/* {
    try_files {path} {path}/index.html
    file_server {
        precompressed br gzip
        status 200
    }
}
basic_auth /private/* {
    alice $2a$14$hash
}
respond "multi
line" 200
file_server browse`);
});

test("checkCaddyFragment rejects anything that could escape the service", () => {
  const cases: [string, RegExp][] = [
    ["other.example.com {\n    respond hi\n}", /looks like a site block/],
    [
      "file_server\n}\nother.example.com {\n    respond hi",
      /unmatched closing brace/,
    ],
    ["handle {\n    file_server", /never closed/],
    ["handle { file_server }", /closing brace on its own line/],
    ["handle {\n    respond hi }\n}", /closing brace on its own line/],
    ['handle "{"\nrespond hi', /quoted brace/],
    ["root * /srv/services/1/repo", /isn't allowed in custom Caddy config/],
    ["reverse_proxy sitey-api:3001", /reverse_proxy" isn't allowed/],
    ["import /etc/caddy/Caddyfile", /import" isn't allowed/],
    ["log_append service_id 1", /log_append" isn't allowed/],
    ["vars root /srv/web", /vars" isn't allowed/],
    ["tls internal", /tls" isn't allowed/],
    ["file_server {\n    root /srv/web\n}", /filesystem root/],
    ["@f file {\n    root /srv/web\n}", /filesystem root/],
    ["file_server browse /etc/passwd", /browse templates/],
    ["file_server {\n    browse /etc/passwd\n}", /browse templates/],
    ["respond {env.CADDY_ADMIN_SOCKET}", /placeholders/],
    ['respond "{$HOME}"', /placeholders/],
    ["respond {file./etc/passwd}", /placeholders/],
    ["respond <<END\nhi\nEND", /heredocs/],
    ["respond hi\\\n}", /backslashes/],
    ['respond "unterminated', /unterminated quote/],
    ["   \n", /empty/],
  ];
  for (const [input, expected] of cases) {
    assert.throws(() => checkCaddyFragment(input), expected, input);
  }
});

test("validateStaticCaddyConfig runs Caddy's adapter on a synthetic site only", async () => {
  let adapted = "";
  mock.method(caddyAdapter, "adapt", async (caddyfile: string) => {
    adapted = caddyfile;
    return '{"apps":{"http":{"servers":{"srv0":{"routes":[{"match":[{"host":["sitey-validate.invalid"]}]}]}}}}}';
  });
  assert.deepEqual(
    await validateStaticCaddyConfig("file_server", { id: 3, outputDir: "out" }),
    { ok: true },
  );
  assert.match(adapted, /^http:\/\/sitey-validate\.invalid \{\n/);
  assert.match(
    adapted,
    /root \* \/srv\/services\/3\/repo\/out\n\s+file_server\n/,
  );

  // Scope failures never reach Caddy.
  let calls = 0;
  mock.method(caddyAdapter, "adapt", async () => {
    calls++;
    return "{}";
  });
  const scoped = await validateStaticCaddyConfig("x.com {\n}", {
    id: 3,
    outputDir: "",
  });
  assert.equal(scoped.ok, false);
  assert.equal(calls, 0);
});

test("Caddy's adapter errors point at the fragment's own line numbers", async () => {
  mock.method(caddyAdapter, "adapt", async () => {
    throw new CaddyRejectedError(
      'Caddy adapt failed (400): {"error":"unrecognized directive: bogus, at Caddyfile:7"}',
    );
  });
  // The fragment starts on line 6 of the synthetic file.
  const adapterResult = await validateStaticCaddyConfig("file_server\nredir", {
    id: 1,
    outputDir: "",
  });
  assert.deepEqual(adapterResult, {
    ok: false,
    unreachable: false,
    message:
      "Caddy rejected the custom config: unrecognized directive: bogus, at line 2",
  });
});

test("an unreachable Caddy is reported as such, not as an invalid config", async () => {
  mock.method(caddyAdapter, "adapt", async () => {
    throw new TypeError("fetch failed");
  });
  const result = await validateStaticCaddyConfig("file_server", {
    id: 1,
    outputDir: "",
  });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.unreachable, true);
});

test("detectMultiPageOutput finds nested index pages, 404.html and many pages", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sitey-output-"));
  try {
    const write = (rel: string) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), "x");
    };
    write("index.html");
    write("assets/app.js");
    assert.deepEqual(detectMultiPageOutput(dir), []);
    write("a.html");
    write("b.html");
    assert.deepEqual(detectMultiPageOutput(dir), []);
    write("c.html");
    assert.deepEqual(detectMultiPageOutput(dir), ["3 top-level .html pages"]);
    write("privacy/index.html");
    write("about/index.html");
    write("404.html");
    assert.deepEqual(detectMultiPageOutput(dir), [
      "404.html",
      "about/index.html",
      "privacy/index.html",
    ]);
    assert.deepEqual(detectMultiPageOutput(path.join(dir, "missing")), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
