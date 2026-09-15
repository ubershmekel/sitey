/**
 * "Is it live?" checks for `status` and `deploy --wait`.
 *
 * For a service: the deployment succeeded; then for each route, the HTTPS
 * certificate is valid for the host, and a GET returns 2xx without Sitey's
 * X-Sitey-Pending placeholder header (following up to 5 same-host redirects;
 * http→https upgrades allowed). A 200 alone isn't proof: routes without a
 * deployment serve pending.html with 200.
 */

import tls from "node:tls";

export type CheckState = "pass" | "pending" | "fail";

export type Check = {
  name: "service" | "deploy" | "tls" | "http";
  target: string;
  state: CheckState;
  detail: string;
};

export type LiveInput = {
  active: boolean;
  deployMode: string;
  deployment: { id: string; status: string } | null;
  /** Route strings (`[http://]host[/path]`); the catch-all is excluded. */
  routes: string[];
};

export type LiveReport = {
  state: CheckState;
  live: boolean;
  checks: Check[];
};

export type Probes = {
  tls(host: string): Promise<Check>;
  http(url: string, deployMode: string): Promise<Check>;
};

export const PENDING_HEADER = "x-sitey-pending";
const MAX_REDIRECTS = 5;
const PROBE_TIMEOUT_MS = 10_000;
const TRANSIENT_HTTP_STATUSES = new Set([502, 503, 504]);

export function routeUrl(route: string): string {
  return route.startsWith("http://") ? route : `https://${route}`;
}

function errorDetail(err: unknown): string {
  const e = err as {
    message?: string;
    code?: string;
    cause?: { code?: string; message?: string };
  };
  const cause = e.cause?.code ?? e.cause?.message;
  return cause
    ? `${e.message}: ${cause}`
    : (e.code ?? e.message ?? String(err));
}

export function probeTls(
  host: string,
  { port = 443, timeoutMs = PROBE_TIMEOUT_MS } = {},
): Promise<Check> {
  const target = `${host}:${port}`;
  return new Promise((resolve) => {
    let settled = false;
    const socket = tls.connect({
      host,
      port,
      servername: host,
      timeout: timeoutMs,
      ALPNProtocols: ["http/1.1"],
    });
    const finish = (state: CheckState, detail: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ name: "tls", target, state, detail });
    };
    // rejectUnauthorized defaults to true: secureConnect only fires for a
    // trusted certificate that matches the host.
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      finish("pass", `certificate valid until ${cert.valid_to}`);
    });
    // Certificates are issued in the background after a route is added, so a
    // failure here is "not yet", not "never".
    socket.once("timeout", () =>
      finish("pending", `timed out after ${timeoutMs}ms`),
    );
    socket.once("error", (err) =>
      finish("pending", `no valid certificate yet (${errorDetail(err)})`),
    );
  });
}

export async function probeHttp(
  url: string,
  deployMode: string,
  { timeoutMs = PROBE_TIMEOUT_MS, fetchImpl = fetch } = {},
): Promise<Check> {
  const check = (state: CheckState, detail: string): Check => ({
    name: "http",
    target: url,
    state,
    detail,
  });
  let current = new URL(url);
  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await fetchImpl(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "user-agent": "siteyctl" },
      });
    } catch (err) {
      return check(
        "pending",
        `GET ${current.href} failed (${errorDetail(err)})`,
      );
    }
    await res.body?.cancel().catch(() => {});

    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      const next = new URL(location, current);
      const sameHost = next.hostname === current.hostname;
      const allowedScheme =
        next.protocol === current.protocol ||
        (current.protocol === "http:" && next.protocol === "https:");
      if (!sameHost || !allowedScheme) {
        return check(
          "fail",
          `HTTP ${res.status} redirects to ${next.href}, which isn't this host`,
        );
      }
      if (hop >= MAX_REDIRECTS) {
        return check("fail", `more than ${MAX_REDIRECTS} redirects`);
      }
      current = next;
      continue;
    }

    if (res.headers.has(PENDING_HEADER)) {
      return check(
        "pending",
        `HTTP ${res.status} is Sitey's placeholder page: nothing deployed is being served yet`,
      );
    }
    if (res.status >= 200 && res.status < 300) {
      return check("pass", `HTTP ${res.status}`);
    }
    if (TRANSIENT_HTTP_STATUSES.has(res.status)) {
      return check(
        "pending",
        `HTTP ${res.status}: the app isn't answering yet`,
      );
    }
    return check(
      "fail",
      deployMode === "server"
        ? `HTTP ${res.status}: the app answered, but not with 2xx, so it isn't counted as live`
        : `HTTP ${res.status}`,
    );
  }
}

export const networkProbes: Probes = {
  tls: (host) => probeTls(host),
  http: (url, deployMode) => probeHttp(url, deployMode),
};

function deploymentCheck(deployment: LiveInput["deployment"]): Check {
  if (!deployment) {
    return {
      name: "deploy",
      target: "",
      state: "fail",
      detail: "no deployments yet",
    };
  }
  const target = deployment.id;
  switch (deployment.status) {
    case "success":
      return { name: "deploy", target, state: "pass", detail: "success" };
    case "failed":
      return {
        name: "deploy",
        target,
        state: "fail",
        detail: "failed (see siteyctl logs)",
      };
    default:
      return {
        name: "deploy",
        target,
        state: "pending",
        detail: deployment.status,
      };
  }
}

export async function runChecks(
  input: LiveInput,
  probes: Probes,
): Promise<LiveReport> {
  const checks: Check[] = [];
  if (!input.active) {
    checks.push({
      name: "service",
      target: "",
      state: "fail",
      detail: "deactivated (siteyctl service activate)",
    });
    return { state: "fail", live: false, checks };
  }

  const deploy = deploymentCheck(input.deployment);
  checks.push(deploy);
  // Until the deploy succeeds, probing routes only shows the placeholder.
  if (deploy.state !== "pass") {
    return { state: deploy.state, live: false, checks };
  }

  const routeChecks = await Promise.all(
    input.routes.map(async (route) => {
      const url = routeUrl(route);
      const results: Check[] = [];
      if (url.startsWith("https://"))
        results.push(await probes.tls(new URL(url).hostname));
      results.push(await probes.http(url, input.deployMode));
      return results;
    }),
  );
  checks.push(...routeChecks.flat());

  const state: CheckState = checks.some((c) => c.state === "fail")
    ? "fail"
    : checks.some((c) => c.state === "pending")
      ? "pending"
      : "pass";
  return { state, live: state === "pass", checks };
}

export type WaitOptions = {
  timeoutMs: number;
  intervalMs?: number;
  /** Route failures (e.g. a 404 right after a Caddy reload) must repeat this many polls to count. */
  failAfterPolls?: number;
  onReport?: (report: LiveReport) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export async function waitForLive(
  load: () => Promise<LiveInput>,
  probes: Probes,
  {
    timeoutMs,
    intervalMs = 3000,
    failAfterPolls = 3,
    onReport,
    now = Date.now,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  }: WaitOptions,
): Promise<LiveReport & { timedOut: boolean }> {
  const started = now();
  let routeFailures = 0;
  for (;;) {
    const report = await runChecks(await load(), probes);
    onReport?.(report);
    if (report.state === "pass") return { ...report, timedOut: false };
    if (report.state === "fail") {
      const hardFailure = report.checks.some(
        (c) =>
          c.state === "fail" && (c.name === "deploy" || c.name === "service"),
      );
      routeFailures++;
      if (hardFailure || routeFailures >= failAfterPolls) {
        return { ...report, timedOut: false };
      }
    } else {
      routeFailures = 0;
    }
    if (now() - started >= timeoutMs) return { ...report, timedOut: true };
    await sleep(
      Math.min(intervalMs, Math.max(0, timeoutMs - (now() - started))),
    );
  }
}
