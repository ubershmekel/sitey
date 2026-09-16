import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  probeHttp,
  probeTls,
  runChecks,
  waitForLive,
  type Check,
  type LiveInput,
  type Probes,
} from "../src/verify.ts";

async function serve(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test("the pending placeholder page is not live, even with 200", async () => {
  const s = await serve((_req, res) => {
    res.writeHead(200, { "X-Sitey-Pending": "1", "content-type": "text/html" });
    res.end("<h1>Deploying…</h1>");
  });
  try {
    const check = await probeHttp(`${s.base}/`, "static");
    assert.equal(check.state, "pending");
    assert.match(check.detail, /placeholder/);
  } finally {
    await s.close();
  }
});

test("follows same-host redirects to a real 2xx", async () => {
  const s = await serve((req, res) => {
    if (req.url === "/api") {
      res.writeHead(308, { location: "/api/" });
      res.end();
    } else {
      res.writeHead(200);
      res.end("ok");
    }
  });
  try {
    assert.deepEqual(await probeHttp(`${s.base}/api`, "server"), {
      name: "http",
      target: `${s.base}/api`,
      state: "pass",
      detail: "HTTP 200",
    });
  } finally {
    await s.close();
  }
});

test("redirects to another host, and redirect loops, fail", async () => {
  const s = await serve((req, res) => {
    if (req.url === "/away")
      res.writeHead(302, { location: "https://example.com/" });
    else res.writeHead(302, { location: "/loop" });
    res.end();
  });
  try {
    const away = await probeHttp(`${s.base}/away`, "static");
    assert.equal(away.state, "fail");
    assert.match(away.detail, /example\.com/);
    const loop = await probeHttp(`${s.base}/loop`, "static");
    assert.equal(loop.state, "fail");
    assert.match(loop.detail, /more than 5 redirects/);
  } finally {
    await s.close();
  }
});

test("server apps answering 404 are reported with the status, not as live; 502 is transient", async () => {
  const s = await serve((req, res) => {
    res.writeHead(req.url === "/down" ? 502 : 404);
    res.end();
  });
  try {
    const notFound = await probeHttp(`${s.base}/`, "server");
    assert.equal(notFound.state, "fail");
    assert.match(notFound.detail, /HTTP 404: the app answered/);
    assert.equal(
      (await probeHttp(`${s.base}/down`, "server")).state,
      "pending",
    );
  } finally {
    await s.close();
  }
});

test("connection failures are pending, not failures", async () => {
  const s = await serve(() => {});
  const url = `${s.base}/`;
  await s.close();
  assert.equal((await probeHttp(url, "static")).state, "pending");
});

test("a TLS endpoint without a valid certificate is pending", async () => {
  // Plain HTTP on the port: the handshake fails like a missing certificate would.
  const s = await serve((_req, res) => res.end());
  try {
    const port = Number(new URL(s.base).port);
    const check = await probeTls("127.0.0.1", { port, timeoutMs: 2000 });
    assert.equal(check.state, "pending");
    assert.equal(check.name, "tls");
  } finally {
    await s.close();
  }
});

const pass = (name: Check["name"], target: string): Check => ({
  name,
  target,
  state: "pass",
  detail: "ok",
});

function probes(overrides: Partial<Probes> = {}): Probes & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    tls: async (host) => (calls.push(`tls ${host}`), pass("tls", host)),
    http: async (url) => (calls.push(`http ${url}`), pass("http", url)),
    ...overrides,
  };
}

const live: LiveInput = {
  active: true,
  deployMode: "static",
  deployment: { id: "d1", status: "success" },
  routes: ["idea-a.andluck.com", "http://localhost/red"],
};

test("runChecks probes TLS only for HTTPS routes", async () => {
  const p = probes();
  const report = await runChecks(live, p);
  assert.equal(report.live, true);
  // Routes are probed concurrently, so compare without order.
  assert.deepEqual([...p.calls].sort(), [
    "http http://localhost/red",
    "http https://idea-a.andluck.com",
    "tls idea-a.andluck.com",
  ]);
});

test("runChecks doesn't probe routes until the deploy succeeds", async () => {
  for (const [status, state] of [
    ["building", "pending"],
    ["failed", "fail"],
  ] as const) {
    const p = probes();
    const report = await runChecks(
      { ...live, deployment: { id: "d2", status } },
      p,
    );
    assert.equal(report.state, state);
    assert.deepEqual(p.calls, []);
  }
  const none = await runChecks({ ...live, deployment: null }, probes());
  assert.equal(none.state, "fail");
  const inactive = await runChecks({ ...live, active: false }, probes());
  assert.equal(inactive.checks[0].name, "service");
});

function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

test("waitForLive times out naming the check that never passed", async () => {
  const p = probes({
    tls: async (host) => ({
      name: "tls",
      target: host,
      state: "pending",
      detail: "no valid certificate yet",
    }),
  });
  const report = await waitForLive(async () => live, p, {
    timeoutMs: 10_000,
    ...clock(),
  });
  assert.equal(report.timedOut, true);
  assert.equal(report.live, false);
  assert.deepEqual(
    report.checks.filter((c) => c.state !== "pass").map((c) => c.name),
    ["tls"],
  );
});

test("waitForLive waits through a build, then passes", async () => {
  const statuses = ["queued", "building", "success"];
  let polls = 0;
  const report = await waitForLive(
    async () => ({
      ...live,
      deployment: { id: "d1", status: statuses[Math.min(polls++, 2)] },
    }),
    probes(),
    { timeoutMs: 60_000, ...clock() },
  );
  assert.equal(report.live, true);
  assert.equal(polls, 3);
});

test("waitForLive stops at once on a failed deploy, but retries a route failure", async () => {
  const failed = await waitForLive(
    async () => ({ ...live, deployment: { id: "d1", status: "failed" } }),
    probes(),
    { timeoutMs: 60_000, ...clock() },
  );
  assert.equal(failed.state, "fail");
  assert.equal(failed.timedOut, false);

  let httpCalls = 0;
  const flaky = probes({
    http: async (url) =>
      ++httpCalls <= 2
        ? { name: "http", target: url, state: "fail", detail: "HTTP 404" }
        : pass("http", url),
  });
  const recovered = await waitForLive(
    async () => ({ ...live, routes: ["http://localhost/red"] }),
    flaky,
    { timeoutMs: 60_000, ...clock() },
  );
  assert.equal(recovered.live, true);

  const alwaysMissing = probes({
    http: async (url) => ({
      name: "http",
      target: url,
      state: "fail",
      detail: "HTTP 404",
    }),
  });
  let loads = 0;
  const gaveUp = await waitForLive(
    async () => (loads++, { ...live, routes: ["http://localhost/red"] }),
    alwaysMissing,
    { timeoutMs: 60_000, ...clock() },
  );
  assert.equal(gaveUp.state, "fail");
  assert.equal(loads, 3);
});

test("a deployment without routes is not publicly verified", async () => {
  const p = probes();
  const report = await runChecks({ ...live, routes: [] }, p);
  assert.equal(report.live, false);
  assert.equal(report.state, "fail");
  assert.match(report.checks.at(-1)!.detail, /no public route/);
  assert.deepEqual(p.calls, []);
});

test("successful HTTP must identify the intended service", async () => {
  for (const header of [null, "1", "42"]) {
    const check = await probeHttp("https://example.com", "static", {
      serviceId: 42,
      fetchImpl: async () =>
        new Response("ok", {
          headers: header ? { "X-Sitey-Service": header } : {},
        }),
    });
    assert.equal(check.state, header === "42" ? "pass" : "fail");
  }
});
