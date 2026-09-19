/**
 * siteyctl end to end against a stand-in tRPC server: real HTTP, the bearer
 * header, error → exit code mapping, --json, and secret handling. The router
 * mimics the procedures siteyctl calls; the server's own behavior is tested in
 * server/tests.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { initTRPC, TRPCError } from "@trpc/server";
import { createHTTPServer } from "@trpc/server/adapters/standalone";
import { z } from "zod";
import { main } from "../src/main.ts";
import type { Probes } from "../src/verify.ts";

const TOKEN = "sitey_good";
const t = initTRPC.context<{ authorization?: string }>().create();
const authed = t.procedure.use(({ ctx, next }) => {
  if (ctx.authorization !== `Bearer ${TOKEN}`) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Not authenticated" });
  }
  return next();
});

const calls: { path: string; input: unknown }[] = [];
const record = (path: string, input: unknown) => calls.push({ path, input });

let envVars: Record<string, string> = { API_KEY: "old-value" };
let routes = ["idea-a.andluck.com"];
let deploymentStatus = "success";
let staticRoutingMode = "spa";
let staticCaddyConfig = "";

const view = () => ({
  id: 42,
  ref: "service-42",
  name: "idea-a",
  repo: "ubershmekel/myswe",
  githubMode: "app",
  branch: "main",
  deployMode: "static",
  buildMode: "auto",
  buildImage: "",
  buildCommand: "npm run build",
  outputDir: "dist",
  staticRoutingMode,
  staticCaddyConfig,
  dockerfilePath: "",
  serverRunCommand: "",
  containerPort: 3000,
  status: "running",
  active: true,
  protected: false,
  env: Object.keys(envVars),
  routes: routes.map((route) => ({
    route,
    httpOnly: false,
    tlsStatus: "active",
  })),
  deployments: [
    {
      id: "dep1",
      status: deploymentStatus,
      triggeredBy: "manual",
      commitSha: null,
      commitMessage: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    },
  ],
});

const appRouter = t.router({
  auth: t.router({
    whoami: authed.query(() => ({
      id: "u1",
      email: "me@example.com",
      mustChangePassword: false,
    })),
  }),
  services: t.router({
    resolve: authed.input(z.object({ ref: z.string() })).query(({ input }) => {
      if (!["idea-a", "42", "service-42"].includes(input.ref)) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `No service named "${input.ref}".`,
        });
      }
      return { id: 42, name: "idea-a", ref: "service-42" };
    }),
    describe: authed.input(z.object({ id: z.number() })).query(view),
    summaries: authed.query(() => [
      {
        id: 42,
        ref: "service-42",
        name: "idea-a",
        repo: "ubershmekel/myswe",
        deployMode: "static",
        status: "running",
        active: true,
        protected: false,
        routes,
        latestDeployment: null,
      },
    ]),
    update: authed
      .input(
        z.object({ id: z.number(), name: z.string().optional() }).passthrough(),
      )
      .mutation(({ input }) => {
        record("services.update", input);
        if (typeof input.staticRoutingMode === "string")
          staticRoutingMode = input.staticRoutingMode;
        if (typeof input.staticCaddyConfig === "string")
          staticCaddyConfig = input.staticCaddyConfig;
        if (input.name === "taken")
          throw new TRPCError({
            code: "CONFLICT",
            message: 'A service named "taken" already exists.',
          });
        return {
          id: 42,
          name: input.name ?? "idea-a",
          warning: null,
          outputDirectoryWarning:
            input.outputDir === "missing"
              ? 'Output directory "missing" does not exist yet.'
              : undefined,
        };
      }),
    create: authed
      .input(z.object({ name: z.string() }).passthrough())
      .mutation(({ input }) => {
        record("services.create", input);
        if (/^\d+$/.test(input.name)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Names can't be purely numeric",
          });
        }
        return {
          id: 44,
          name: input.name,
          deploymentId: "dep44",
          warning: null,
          routes: ((input.routes ?? []) as string[]).map((route) => ({
            route,
            tlsStatus: "active",
            alreadyExisted: false,
          })),
        };
      }),
    checkRoute: authed
      .input(z.object({ route: z.string() }))
      .query(({ input }) => {
        if (input.route.endsWith("example.com")) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `No domain covers ${input.route}.`,
          });
        }
        return {
          route: input.route,
          takenBy:
            input.route === "taken.andluck.com"
              ? { id: 7, name: "other", ref: "service-7" }
              : null,
        };
      }),
    addRoute: authed
      .input(z.object({ serviceId: z.number(), host: z.string() }))
      .mutation(({ input }) => {
        record("services.addRoute", input);
        const alreadyExisted = routes.includes(input.host);
        if (!alreadyExisted) routes.push(input.host);
        return {
          routeString: input.host,
          httpOnly: false,
          tlsStatus: "active",
          alreadyExisted,
        };
      }),
    envValues: authed.input(z.object({ id: z.number() })).query(() => envVars),
    getEnvVar: authed
      .input(z.object({ id: z.number(), name: z.string() }))
      .query(({ input }) => {
        if (!(input.name in envVars))
          throw new TRPCError({ code: "NOT_FOUND" });
        return { name: input.name, value: envVars[input.name] };
      }),
    setEnvVar: authed
      .input(z.object({ id: z.number(), name: z.string(), value: z.string() }))
      .mutation(({ input }) => {
        envVars[input.name] = input.value;
        return { ok: true, name: input.name, env: Object.keys(envVars) };
      }),
    delete: authed
      .input(z.object({ id: z.number(), confirmName: z.string().optional() }))
      .mutation(({ input }) => {
        record("services.delete", input);
        return { ok: true };
      }),
  }),
  github: t.router({
    checkRepoAccess: authed
      .input(z.object({ owner: z.string(), name: z.string() }))
      .query(({ input }) => ({
        configured: true,
        accessible: input.name !== "private-elsewhere",
        installUrl: "https://github.com/apps/sitey/installations/new",
      })),
  }),
  system: t.router({
    exportConfig: authed.query(() => ({ yaml: "version: 1\nservices: {}\n" })),
  }),
});

let base = "";
let closeServer = () => {};
let dir = "";

before(async () => {
  const server = createHTTPServer({
    basePath: "/api/trpc/",
    router: appRouter,
    createContext: ({ req }) => ({ authorization: req.headers.authorization }),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closeServer = () => server.close();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "siteyctl-test-"));
});

after(() => {
  closeServer();
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeProfiles(token = TOKEN) {
  const file = path.join(dir, `servers-${Math.random()}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({ servers: { local: { url: base, token } } }),
  );
  process.env.SITEYCTL_CONFIG = file;
  return file;
}

const passProbes: Probes = {
  tls: async (host) => ({
    name: "tls",
    target: host,
    state: "pass",
    detail: "ok",
  }),
  http: async (url) => ({
    name: "http",
    target: url,
    state: "pass",
    detail: "HTTP 200",
  }),
};

async function cli(argv: string[], overrides: Record<string, unknown> = {}) {
  let stdout = "";
  let stderr = "";
  const code = await main(
    argv,
    {
      probes: passProbes,
      log: (line: string) => void (stderr += `${line}\n`),
      cwd: dir,
      ...overrides,
    },
    { out: (s) => void (stdout += s), err: (s) => void (stderr += s) },
  );
  return { code, stdout, stderr };
}

test("--json prints the result on stdout and exits 0", async () => {
  writeProfiles();
  const r = await cli(["service", "get", "service-42", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.id, 42);
  assert.deepEqual(parsed.env, ["API_KEY"]);
});

test("not found exits 3; conflict exits 3; validation exits 2", async () => {
  writeProfiles();
  const missing = await cli(["service", "get", "nope"]);
  assert.equal(missing.code, 3);
  assert.match(missing.stderr, /No service named "nope"/);
  assert.equal(missing.stdout, "");

  const conflict = await cli(["service", "rename", "idea-a", "taken"]);
  assert.equal(conflict.code, 3);
  assert.match(conflict.stderr, /already exists/);

  const invalid = await cli([
    "service",
    "create",
    "42",
    "--repo",
    "ubershmekel/myswe",
    "--mode",
    "static",
  ]);
  assert.equal(invalid.code, 2);

  const usage = await cli([
    "service",
    "create",
    "idea-c",
    "--repo",
    "ubershmekel/myswe",
  ]);
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /--mode static or --mode server is required/);
});

test("a rejected token exits 1 and says how to fix it", async () => {
  writeProfiles("sitey_revoked");
  const r = await cli(["services"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /rejected/);
  assert.match(r.stderr, /sitey token create/);
});

test("env set reads the value from stdin and never prints it", async () => {
  writeProfiles();
  const r = await cli(["env", "set", "idea-a", "STRIPE_KEY", "--json"], {
    readSecret: async () => "sk_live_very_secret",
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(envVars.STRIPE_KEY, "sk_live_very_secret");
  assert.ok(!r.stdout.includes("sk_live"));
  assert.ok(!r.stderr.includes("sk_live"));
  assert.deepEqual(JSON.parse(r.stdout).env, ["API_KEY", "STRIPE_KEY"]);

  const inline = await cli([
    "env",
    "set",
    "idea-a",
    "STRIPE_KEY=sk_live_inline",
  ]);
  assert.equal(inline.code, 2);
  assert.match(inline.stderr, /value comes from stdin/);
  assert.ok(!inline.stderr.includes("sk_live_inline"));
});

test("route add is a no-op the second time", async () => {
  writeProfiles();
  const first = await cli(["route", "add", "idea-a", "new.andluck.com"]);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /Route added/);
  const second = await cli(["route", "add", "idea-a", "new.andluck.com"]);
  assert.equal(second.code, 0);
  assert.match(
    second.stdout,
    /already has route new\.andluck\.com; nothing changed/,
  );
});

test("service create checks the repo and routes before creating anything", async () => {
  writeProfiles();
  calls.length = 0;
  const hidden = await cli([
    "service",
    "create",
    "idea-c",
    "--repo",
    "me/private-elsewhere",
    "--mode",
    "static",
  ]);
  assert.equal(hidden.code, 1);
  assert.match(
    hidden.stderr,
    /can't see me\/private-elsewhere.*installations\/new/,
  );

  const taken = await cli([
    "service",
    "create",
    "idea-c",
    "--repo",
    "ubershmekel/myswe",
    "--mode",
    "static",
    "--route",
    "ok.andluck.com",
    "--route",
    "taken.andluck.com",
  ]);
  assert.equal(taken.code, 3);
  assert.match(
    taken.stderr,
    /already routed to service "other".*Nothing was created/,
  );

  const uncovered = await cli([
    "service",
    "create",
    "idea-c",
    "--repo",
    "ubershmekel/myswe",
    "--mode",
    "static",
    "--route",
    "shop.example.com",
  ]);
  assert.equal(uncovered.code, 3);
  assert.equal(calls.length, 0);

  const created = await cli([
    "service",
    "create",
    "idea-c",
    "--repo",
    "https://github.com/ubershmekel/myswe.git",
    "--mode",
    "static",
    "--output-dir",
    "landings/idea-c/dist",
    "--route",
    "idea-c.andluck.com",
    "--json",
  ]);
  assert.equal(created.code, 0, created.stderr);
  assert.deepEqual(JSON.parse(created.stdout), {
    id: 44,
    ref: "service-44",
    name: "idea-c",
    deploymentId: "dep44",
    warning: null,
    routes: [
      {
        route: "idea-c.andluck.com",
        tlsStatus: "active",
        alreadyExisted: false,
      },
    ],
  });
  assert.deepEqual(
    calls.map((c) => c.path),
    ["services.create"],
  );
  assert.deepEqual(calls[0].input, {
    name: "idea-c",
    repoOwner: "ubershmekel",
    repoName: "myswe",
    deployMode: "static",
    githubMode: "app",
    outputDir: "landings/idea-c/dist",
    routes: ["idea-c.andluck.com"],
  });
});

test("service delete requires --confirm with the current name", async () => {
  writeProfiles();
  calls.length = 0;
  const bare = await cli(["service", "delete", "idea-a"]);
  assert.equal(bare.code, 2);
  assert.match(bare.stderr, /Prefer: siteyctl service deactivate idea-a/);
  const wrong = await cli([
    "service",
    "delete",
    "idea-a",
    "--confirm",
    "idea-b",
  ]);
  assert.equal(wrong.code, 2);
  assert.equal(calls.length, 0);
  const ok = await cli([
    "service",
    "delete",
    "service-42",
    "--confirm",
    "idea-a",
  ]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(calls, [
    { path: "services.delete", input: { id: 42, confirmName: "idea-a" } },
  ]);
});

test("status --wait exits 4 on timeout and names the failing check", async () => {
  writeProfiles();
  routes = ["idea-a.andluck.com"];
  const r = await cli(
    ["status", "idea-a", "--wait", "--timeout", "1", "--json"],
    {
      probes: {
        ...passProbes,
        tls: async (host: string) => ({
          name: "tls",
          target: host,
          state: "pending",
          detail: "no valid certificate yet",
        }),
      },
    },
  );
  assert.equal(r.code, 4);
  const report = JSON.parse(r.stdout);
  assert.equal(report.timedOut, true);
  assert.deepEqual(
    report.checks
      .filter((c: { state: string }) => c.state !== "pass")
      .map((c: { name: string }) => c.name),
    ["tls"],
  );

  const liveNow = await cli(["status", "idea-a"]);
  assert.equal(liveNow.code, 0, liveNow.stderr);
  assert.match(liveNow.stdout, /Live: yes/);
});

test("export -o writes exactly the server's bytes", async () => {
  writeProfiles();
  const r = await cli(["export", "-o", "sitey/andluck.yaml"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(
    fs.readFileSync(path.join(dir, "sitey/andluck.yaml"), "utf8"),
    "version: 1\nservices: {}\n",
  );
});

test("login verifies the token before saving it, then selects the only profile", async () => {
  const file = path.join(dir, "fresh", "servers.json");
  process.env.SITEYCTL_CONFIG = file;
  const bad = await cli(["login", "local", base], {
    readSecret: async () => "sitey_wrong\n",
  });
  assert.equal(bad.code, 1);
  assert.ok(!fs.existsSync(file));

  const insecure = await cli(["login", "remote", "http://sitey.example.com"], {
    readSecret: async () => TOKEN,
  });
  assert.equal(insecure.code, 2);
  assert.match(insecure.stderr, /requires HTTPS/);

  const ok = await cli(["login", "local", `${base}/`], {
    readSecret: async () => `${TOKEN}\n`,
  });
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /as me@example\.com/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    servers: { local: { url: base, token: TOKEN } },
  });
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }

  const servers = await cli(["servers"]);
  assert.ok(!servers.stdout.includes(TOKEN));
  assert.equal((await cli(["services"])).code, 0);
});

test("several profiles need --server or $SITEY_SERVER", async () => {
  const file = writeProfiles();
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  data.servers.other = { url: "https://sitey.example.com", token: "x" };
  fs.writeFileSync(file, JSON.stringify(data));
  const ambiguous = await cli(["services"]);
  assert.equal(ambiguous.code, 2);
  assert.match(ambiguous.stderr, /Several servers configured \(local, other\)/);
  assert.equal((await cli(["services", "--server", "local"])).code, 0);
  process.env.SITEY_SERVER = "local";
  try {
    assert.equal((await cli(["services"])).code, 0);
  } finally {
    delete process.env.SITEY_SERVER;
  }
});

test("env values are disclosed only by explicit env commands", async () => {
  writeProfiles();
  envVars = { TOKEN: "deliberate-secret-read" };
  const names = await cli(["env", "list", "idea-a", "--json"]);
  assert.equal(names.code, 0);
  assert.ok(!names.stdout.includes(envVars.TOKEN));
  const single = await cli(["env", "get", "idea-a", "TOKEN"]);
  assert.equal(single.code, 0);
  assert.equal(single.stdout, "deliberate-secret-read\n");
  const all = await cli(["env", "list", "idea-a", "--values", "--json"]);
  assert.deepEqual(JSON.parse(all.stdout).values, envVars);
  const missing = await cli(["env", "get", "idea-a", "MISSING"]);
  assert.equal(missing.code, 3);
});

test("static routing flags: create, set from a file, and get", async () => {
  writeProfiles();
  calls.length = 0;
  const created = await cli([
    "service",
    "create",
    "examplesite",
    "--repo",
    "me/site",
    "--mode",
    "static",
    "--output-dir",
    "dist",
    "--static-routing",
    "multi-page",
  ]);
  assert.equal(created.code, 0, created.stderr);
  assert.equal(
    (calls[0].input as { staticRoutingMode: string }).staticRoutingMode,
    "multi-page",
  );

  const server = await cli([
    "service",
    "create",
    "api",
    "--repo",
    "me/site",
    "--mode",
    "server",
    "--static-routing",
    "spa",
  ]);
  assert.equal(server.code, 2);
  assert.match(server.stderr, /--static-routing only applies to --mode static/);

  const invalid = await cli([
    "service",
    "set",
    "idea-a",
    "--static-routing",
    "pages",
  ]);
  assert.equal(invalid.code, 2);
  assert.match(invalid.stderr, /one of: spa, multi-page, caddy/);

  // Routing alone is applied by a reload: no deploy hint.
  calls.length = 0;
  const set = await cli([
    "service",
    "set",
    "idea-a",
    "--static-routing",
    "spa",
  ]);
  assert.equal(set.code, 0, set.stderr);
  assert.match(set.stdout, /Routing applied \(Caddy reloaded\)/);
  assert.doesNotMatch(set.stdout, /Not deployed yet/);
  const mixed = await cli([
    "service",
    "set",
    "idea-a",
    "--static-routing",
    "multi-page",
    "--output-dir",
    "build",
  ]);
  assert.match(mixed.stdout, /Routing applied/);
  assert.doesNotMatch(mixed.stdout, /Not deployed yet/);
  const folder = await cli([
    "service",
    "set",
    "idea-a",
    "--output-dir",
    "missing",
  ]);
  assert.equal(folder.code, 0);
  assert.match(
    folder.stderr,
    /Warning: Output directory "missing" does not exist/,
  );
  assert.match(folder.stdout, /Routing applied/);
  assert.doesNotMatch(folder.stdout, /Not deployed yet/);
  const folderJson = await cli([
    "service",
    "set",
    "idea-a",
    "--output-dir",
    "missing",
    "--json",
  ]);
  assert.match(
    JSON.parse(folderJson.stdout).outputDirectoryWarning,
    /does not exist/,
  );
  const buildChange = await cli([
    "service",
    "set",
    "idea-a",
    "--output-dir",
    "build",
    "--build-command",
    "npm run build",
  ]);
  assert.match(buildChange.stdout, /Routing applied[\s\S]*Not deployed yet/);

  // A fragment is read from a file (relative to the working directory), and
  // implies caddy mode.
  const fragment =
    'redir /old /new 308\nheader X-Frame-Options "DENY"\nfile_server\n';
  fs.writeFileSync(path.join(dir, "routing.caddy"), fragment);
  calls.length = 0;
  const custom = await cli([
    "service",
    "set",
    "idea-a",
    "--static-caddy-file",
    "routing.caddy",
    "--json",
  ]);
  assert.equal(custom.code, 0, custom.stderr);
  assert.deepEqual(calls[0].input, {
    id: 42,
    staticRoutingMode: "caddy",
    staticCaddyConfig: fragment,
  });
  assert.deepEqual(JSON.parse(custom.stdout).changed, [
    "staticRoutingMode",
    "staticCaddyConfig",
  ]);
  const conflicting = await cli([
    "service",
    "set",
    "idea-a",
    "--static-routing",
    "spa",
    "--static-caddy-file",
    "routing.caddy",
  ]);
  assert.equal(conflicting.code, 2);
  const missing = await cli([
    "service",
    "set",
    "idea-a",
    "--static-caddy-file",
    "nope.caddy",
  ]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Can't read --static-caddy-file/);

  const get = await cli(["service", "get", "idea-a"]);
  assert.match(get.stdout, /routing:\s+caddy/);
  assert.match(
    get.stdout,
    /static caddy config:\n  redir \/old \/new 308\n  header X-Frame-Options "DENY"\n  file_server\n/,
  );
  const json = JSON.parse(
    (await cli(["service", "get", "idea-a", "--json"])).stdout,
  );
  assert.equal(json.staticRoutingMode, "caddy");
  assert.equal(json.staticCaddyConfig, fragment);
  staticRoutingMode = "spa";
  staticCaddyConfig = "";
});
