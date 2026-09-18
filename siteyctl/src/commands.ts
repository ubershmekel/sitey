import fs from "node:fs";
import path from "node:path";
import type { inferRouterOutputs } from "@trpc/server";
import { UsageError, type Invocation } from "./args.ts";
import {
  CliError,
  createApi,
  describeError,
  EXIT,
  type Api,
  type AppRouter,
} from "./api.ts";
import { ago, keyValues, table } from "./format.ts";
import {
  loadProfiles,
  normalizeServerUrl,
  saveProfiles,
  selectProfile,
  validateProfileName,
} from "./profiles.ts";
import {
  networkProbes,
  runChecks,
  waitForLive,
  type Check,
  type LiveInput,
  type LiveReport,
  type Probes,
} from "./verify.ts";

type Outputs = inferRouterOutputs<AppRouter>;
type ServiceView = Outputs["services"]["describe"];

export type RunInvocation = Extract<Invocation, { kind: "run" }>;

export type Context = {
  inv: RunInvocation;
  /** The selected server profile's API client (selected lazily). */
  api(): Api;
  server(): { name: string; url: string };
  /** Progress and diagnostics: always stderr, so stdout stays parseable. */
  log(line: string): void;
  readSecret(prompt: string): Promise<string>;
  probes: Probes;
  /** Where relative paths given on the command line are resolved. */
  cwd: string;
};

export type Result = { json: unknown; text?: string; exitCode?: number };

type Handler = (ctx: Context) => Promise<Result>;

// ── Option helpers ──────────────────────────────────────────────────────────

function str(ctx: Context, name: string): string | undefined {
  const value = ctx.inv.options[name];
  return typeof value === "string" ? value : undefined;
}

function flag(ctx: Context, name: string): boolean {
  return ctx.inv.options[name] === true;
}

function arg(ctx: Context, name: string): string {
  return ctx.inv.args[name] ?? "";
}

function intOption(
  ctx: Context,
  name: string,
  { min, max, fallback }: { min: number; max: number; fallback?: number },
): number | undefined {
  const raw = str(ctx, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new UsageError(
      `--${name} must be a whole number from ${min} to ${max}.`,
      ctx.inv.command,
    );
  }
  return value;
}

function oneOf<T extends string>(
  ctx: Context,
  name: string,
  values: readonly T[],
): T | undefined {
  const raw = str(ctx, name);
  if (raw === undefined) return undefined;
  if (!(values as readonly string[]).includes(raw)) {
    throw new UsageError(
      `--${name} must be one of: ${values.join(", ")}.`,
      ctx.inv.command,
    );
  }
  return raw as T;
}

function parseRepo(
  ctx: Context,
  raw: string,
): { repoOwner: string; repoName: string } {
  const match =
    /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(
      raw.trim(),
    );
  if (!match) {
    throw new UsageError(
      `--repo must be owner/name, e.g. ubershmekel/myswe (got "${raw}").`,
      ctx.inv.command,
    );
  }
  return { repoOwner: match[1], repoName: match[2] };
}

async function resolveService(ctx: Context, ref = arg(ctx, "service")) {
  return ctx.api().services.resolve.query({ ref });
}

function label(service: { name: string; ref: string }): string {
  return `${service.name} (${service.ref})`;
}

// ── Build/run settings shared by create and set ─────────────────────────────

function buildSettings(ctx: Context) {
  const dockerfile = str(ctx, "dockerfile");
  if (dockerfile !== undefined && flag(ctx, "no-dockerfile")) {
    throw new UsageError(
      "Use either --dockerfile or --no-dockerfile, not both.",
      ctx.inv.command,
    );
  }
  return {
    branch: str(ctx, "branch"),
    buildImage: str(ctx, "build-image"),
    buildCommand: str(ctx, "build-command"),
    outputDir: str(ctx, "output-dir"),
    serverRunCommand: str(ctx, "run-command"),
    containerPort: intOption(ctx, "port", { min: 1, max: 65535 }),
    buildMode:
      dockerfile !== undefined
        ? ("dockerfile" as const)
        : flag(ctx, "no-dockerfile")
          ? ("auto" as const)
          : undefined,
    dockerfilePath: dockerfile,
  };
}

// ── Static routing, shared by create and set ────────────────────────────────

const ROUTING_FLAGS = ["static-routing", "static-caddy-file"] as const;

function routingSettings(ctx: Context) {
  let mode = oneOf(ctx, "static-routing", [
    "spa",
    "multi-page",
    "caddy",
  ] as const);
  const file = str(ctx, "static-caddy-file");
  let staticCaddyConfig: string | undefined;
  if (file !== undefined) {
    if (mode && mode !== "caddy")
      throw new UsageError(
        `--static-caddy-file needs --static-routing caddy (got ${mode}).`,
        ctx.inv.command,
      );
    mode = "caddy";
    const resolved = path.resolve(ctx.cwd, file);
    try {
      staticCaddyConfig = fs.readFileSync(resolved, "utf8");
    } catch (err) {
      throw new CliError(
        `Can't read --static-caddy-file ${resolved}: ${(err as Error).message}`,
      );
    }
  }
  return { staticRoutingMode: mode, staticCaddyConfig };
}

function withoutUndefined<T extends Record<string, unknown>>(
  obj: T,
): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

// ── Live checks ─────────────────────────────────────────────────────────────

const SYMBOL: Record<Check["state"], string> = {
  pass: "✓",
  pending: "…",
  fail: "✗",
};

function checkLine(c: Check): string {
  const target = c.target && c.name !== "deploy" ? `${c.target}: ` : "";
  const deployId =
    c.name === "deploy" && c.target ? ` (deployment ${c.target})` : "";
  return `  ${SYMBOL[c.state]} ${c.name.padEnd(7)} ${target}${c.detail}${deployId}`;
}

function liveInput(
  view: ServiceView,
  deployment: LiveInput["deployment"],
): LiveInput {
  return {
    serviceId: view.id,
    active: view.active,
    deployMode: view.deployMode,
    deployment,
    routes: view.routes.map((r) => r.route).filter((r) => r !== "(catch-all)"),
  };
}

function reportText(
  service: { name: string; ref: string },
  report: LiveReport & { timedOut?: boolean },
  routes: string[],
): string {
  const lines = [label(service), ...report.checks.map(checkLine)];
  if (report.live && !routes.length)
    lines.push("  (no routes: nothing to probe)");
  if (report.timedOut) {
    const waiting = report.checks
      .filter((c) => c.state !== "pass")
      .map((c) => c.name);
    lines.push(
      `Timed out; still waiting on: ${[...new Set(waiting)].join(", ")}.`,
    );
  } else {
    lines.push(`Live: ${report.live ? "yes" : "no"}`);
  }
  return lines.join("\n");
}

async function waitOrCheck(
  ctx: Context,
  service: { id: number; name: string; ref: string },
  deploymentId: string | undefined,
): Promise<Result> {
  const api = ctx.api();
  let routes: string[] = [];
  const load = async (): Promise<LiveInput> => {
    const view = await api.services.describe.query({ id: service.id });
    const deployment = deploymentId
      ? await api.deploy.get.query({ id: deploymentId })
      : (view.deployments[0] ?? null);
    const input = liveInput(
      view,
      deployment && { id: deployment.id, status: deployment.status },
    );
    routes = input.routes;
    return input;
  };

  let report: LiveReport & { timedOut: boolean };
  if (flag(ctx, "wait")) {
    const timeoutSeconds = intOption(ctx, "timeout", {
      min: 1,
      max: 86_400,
      fallback: 300,
    })!;
    let previous = new Set<string>();
    report = await waitForLive(load, ctx.probes, {
      timeoutMs: timeoutSeconds * 1000,
      onReport: (r) => {
        const lines = r.checks.map(checkLine);
        for (const line of lines) if (!previous.has(line)) ctx.log(line);
        previous = new Set(lines);
      },
    });
  } else {
    report = {
      ...(await runChecks(await load(), ctx.probes)),
      timedOut: false,
    };
  }

  return {
    json: {
      service,
      live: report.live,
      state: report.state,
      timedOut: report.timedOut,
      checks: report.checks,
    },
    text: reportText(service, report, routes),
    exitCode: report.live
      ? EXIT.OK
      : report.timedOut
        ? EXIT.TIMEOUT
        : EXIT.ERROR,
  };
}

// ── Handlers ────────────────────────────────────────────────────────────────

const handlers: Record<string, Handler> = {
  async login(ctx) {
    const name = arg(ctx, "server-name");
    validateProfileName(name);
    const url = normalizeServerUrl(arg(ctx, "url"));
    const token = (
      await ctx.readSecret(
        `API token for ${url} (from: ssh <vps> sitey token create <name>): `,
      )
    ).trim();
    if (!token) throw new UsageError("No token given.", ctx.inv.command);

    let who;
    try {
      who = await createApi(url, token).auth.whoami.query();
    } catch (err) {
      const report = describeError(err, { name, url });
      throw new CliError(report.message, report.exitCode);
    }
    const data = loadProfiles();
    data.servers[name] = { url, token };
    saveProfiles(data);
    if (who.mustChangePassword) {
      ctx.log(
        `Warning: ${who.email} must change their password in the web UI before the API accepts changes.`,
      );
    }
    return {
      json: { server: name, url, email: who.email },
      text: `Logged in to ${name} (${url}) as ${who.email}.`,
    };
  },

  async servers() {
    const data = loadProfiles();
    const rows = Object.entries(data.servers).map(([name, p]) => ({
      name,
      url: p.url,
    }));
    return {
      json: rows,
      text: rows.length
        ? table(
            ["NAME", "URL"],
            rows.map((r) => [r.name, r.url]),
          )
        : "No servers configured. Run siteyctl login <server-name> <url>.",
    };
  },

  async services(ctx) {
    const services = await ctx.api().services.summaries.query();
    return {
      json: services,
      text: table(
        ["ID", "NAME", "MODE", "STATUS", "DEPLOY", "ROUTES"],
        services.map((s) => [
          s.ref,
          s.name,
          s.protected ? "panel" : s.deployMode,
          s.active ? s.status : "inactive",
          s.latestDeployment
            ? `${s.latestDeployment.status} ${ago(s.latestDeployment.createdAt)}`
            : "-",
          s.routes.join(", ") || "-",
        ]),
      ),
    };
  },

  async "service get"(ctx) {
    const { id } = await resolveService(ctx);
    const s = await ctx.api().services.describe.query({ id });
    const isServer = s.deployMode === "server";
    const text = [
      keyValues([
        ["id", s.ref],
        ["name", s.name],
        ["repo", `${s.repo} (${s.githubMode})`],
        ["branch", s.branch],
        ["mode", s.deployMode],
        ["active", s.active ? "yes" : "no (siteyctl service activate)"],
        ["status", s.status],
        ["buildImage", s.buildImage],
        ["buildCommand", s.buildCommand],
        ["outputDir", isServer ? undefined : s.outputDir || "(repo root)"],
        ["routing", isServer ? undefined : s.staticRoutingMode],
        [
          "dockerfile",
          isServer && s.buildMode === "dockerfile"
            ? s.dockerfilePath || "Dockerfile"
            : undefined,
        ],
        ["runCommand", isServer ? s.serverRunCommand : undefined],
        ["port", isServer ? s.containerPort : undefined],
      ]),
      ...(!isServer && s.staticRoutingMode === "caddy"
        ? [
            "",
            "static caddy config:",
            ...s.staticCaddyConfig
              .replace(/\s+$/, "")
              .split("\n")
              .map((line) => `  ${line}`),
          ]
        : []),
      "",
      "routes:",
      ...(s.routes.length
        ? s.routes.map(
            (r) =>
              `  ${r.route}${r.route === "(catch-all)" || r.httpOnly ? "" : `  (tls ${r.tlsStatus})`}`,
          )
        : ["  (none; add one with siteyctl route add)"]),
      "",
      "env (names only):",
      ...(s.env.length ? s.env.map((n) => `  ${n}`) : ["  (none)"]),
      "",
      "deployments:",
      ...(s.deployments.length
        ? s.deployments.map(
            (d) =>
              `  ${d.id}  ${d.status.padEnd(8)} ${ago(d.createdAt)}  ${d.triggeredBy}${d.commitSha ? `  ${d.commitSha.slice(0, 7)}` : ""}${d.commitMessage ? `  ${d.commitMessage.split("\n")[0]}` : ""}`,
          )
        : ["  (none)"]),
    ].join("\n");
    return { json: s, text };
  },

  async "service create"(ctx) {
    const api = ctx.api();
    const name = arg(ctx, "name");
    const repoFlag = str(ctx, "repo");
    if (!repoFlag)
      throw new UsageError("--repo owner/name is required.", ctx.inv.command);
    const { repoOwner, repoName } = parseRepo(ctx, repoFlag);
    const deployMode = oneOf(ctx, "mode", ["static", "server"] as const);
    if (!deployMode)
      throw new UsageError(
        "--mode static or --mode server is required.",
        ctx.inv.command,
      );
    const githubMode =
      oneOf(ctx, "github-mode", ["app", "webhook"] as const) ?? "app";
    const settings = buildSettings(ctx);
    const routing = routingSettings(ctx);
    if (deployMode === "static") {
      for (const [option, value] of [
        ["run-command", settings.serverRunCommand],
        ["port", settings.containerPort],
        ["dockerfile", settings.dockerfilePath],
      ] as const) {
        if (value !== undefined)
          throw new UsageError(
            `--${option} only applies to --mode server.`,
            ctx.inv.command,
          );
      }
    } else {
      for (const option of ["output-dir", ...ROUTING_FLAGS]) {
        if (str(ctx, option) !== undefined)
          throw new UsageError(
            `--${option} only applies to --mode static.`,
            ctx.inv.command,
          );
      }
    }
    const routes = (ctx.inv.options.route as string[] | undefined) ?? [];

    // Preflight everything that can fail before creating anything.
    if (githubMode === "app") {
      const access = await api.github.checkRepoAccess.query({
        owner: repoOwner,
        name: repoName,
      });
      if (!access.configured) {
        throw new CliError(
          "The GitHub App isn't connected on this server. Needs a human: connect it in the web UI (Integrations), or use --github-mode webhook.",
        );
      }
      if (!access.accessible) {
        throw new CliError(
          `The GitHub App can't see ${repoOwner}/${repoName}. Needs a human: install the App on that repo` +
            (access.installUrl ? ` at ${access.installUrl}` : "") +
            ", or use --github-mode webhook.",
        );
      }
    }
    for (const route of routes) {
      const check = await api.services.checkRoute.query({ route });
      if (check.takenBy) {
        throw new CliError(
          `${check.route} is already routed to service "${check.takenBy.name}" (${check.takenBy.ref}). Nothing was created.`,
          EXIT.CONFLICT_OR_NOT_FOUND,
        );
      }
    }

    const created = await api.services.create.mutate({
      name,
      repoOwner,
      repoName,
      deployMode,
      githubMode,
      routes,
      ...withoutUndefined(settings),
      ...withoutUndefined(routing),
    });
    const ref = `service-${created.id}`;
    ctx.log(
      `Created ${name} (${ref}). First deploy queued (deployment ${created.deploymentId}).`,
    );

    const added = created.routes;
    if (created.warning) ctx.log(`Warning: ${created.warning}`);
    for (const route of added) ctx.log(`Route added: ${route.route}`);

    const next = [`Next: siteyctl status ${name} --wait`];
    if (githubMode === "webhook") {
      next.push(
        "Webhook mode: needs a human to add the GitHub webhook shown on the service page in the web UI.",
      );
    }
    return {
      json: {
        id: created.id,
        ref,
        name,
        deploymentId: created.deploymentId,
        routes: added,
        warning: created.warning,
      },
      text: [`${name} (${ref})`, ...next].join("\n"),
    };
  },

  async "service set"(ctx) {
    const service = await resolveService(ctx);
    const build = withoutUndefined({
      deployMode: oneOf(ctx, "mode", ["static", "server"] as const),
      ...buildSettings(ctx),
    });
    const routing = withoutUndefined(routingSettings(ctx));
    const changes = { ...build, ...routing };
    if (!Object.keys(changes).length) {
      throw new UsageError(
        "Nothing to change. Pass at least one setting flag.",
        ctx.inv.command,
      );
    }
    const result = await ctx
      .api()
      .services.update.mutate({ id: service.id, ...changes });
    if (result.warning) ctx.log(`Warning: ${result.warning}`);
    const text = [
      `Updated ${label(service)}: ${Object.keys(changes).join(", ")}.`,
    ];
    // Routing is live once Caddy reloads; build/run settings wait for a deploy.
    if (Object.keys(routing).length)
      text.push(
        result.warning
          ? "Routing saved but not applied yet: retry this command."
          : "Routing applied (Caddy reloaded).",
      );
    if (Object.keys(build).length)
      text.push(`Not deployed yet: siteyctl deploy ${service.name} --wait`);
    return {
      json: {
        id: service.id,
        ref: service.ref,
        name: service.name,
        changed: Object.keys(changes),
        warning: result.warning,
      },
      text: text.join("\n"),
    };
  },

  async "service rename"(ctx) {
    const service = await resolveService(ctx);
    const newName = arg(ctx, "new-name");
    const updated = await ctx
      .api()
      .services.update.mutate({ id: service.id, name: newName });
    return {
      json: {
        id: service.id,
        ref: service.ref,
        oldName: service.name,
        name: updated.name,
      },
      text: `Renamed ${service.name} → ${updated.name} (${service.ref}).`,
    };
  },

  async "service deactivate"(ctx) {
    const service = await resolveService(ctx);
    const result = await ctx
      .api()
      .services.deactivate.mutate({ id: service.id });
    if (result.warning) ctx.log(`Warning: ${result.warning}`);
    return {
      json: {
        id: service.id,
        ref: service.ref,
        name: service.name,
        active: false,
        warning: result.warning,
      },
      text: `Deactivated ${label(service)}: routing removal requested; data kept.\nUndo: siteyctl service activate ${service.name}`,
    };
  },

  async "service activate"(ctx) {
    const service = await resolveService(ctx);
    const api = ctx.api();
    const result = await api.services.activate.mutate({ id: service.id });
    if (result.warning) ctx.log(`Warning: ${result.warning}`);
    const view = await api.services.describe.query({ id: service.id });
    const hint =
      view.deployMode === "server"
        ? `Server apps need a deploy to start again: siteyctl deploy ${service.name} --wait`
        : `Check it: siteyctl status ${service.name}`;
    return {
      json: {
        id: service.id,
        ref: service.ref,
        name: service.name,
        active: true,
        warning: result.warning,
      },
      text: `Activated ${label(service)}.\n${hint}`,
    };
  },

  async "service delete"(ctx) {
    const service = await resolveService(ctx);
    const confirm = str(ctx, "confirm");
    if (confirm === undefined) {
      throw new UsageError(
        `Deleting ${label(service)} removes its files, routes and deployment history for good. ` +
          `Prefer: siteyctl service deactivate ${service.name}\n` +
          `To delete anyway: siteyctl service delete ${service.name} --confirm ${service.name}`,
        ctx.inv.command,
      );
    }
    if (confirm !== service.name) {
      throw new UsageError(
        `--confirm "${confirm}" doesn't match the service's name "${service.name}". Nothing was deleted.`,
        ctx.inv.command,
      );
    }
    const result = await ctx
      .api()
      .services.delete.mutate({ id: service.id, confirmName: confirm });
    if (result.warning) ctx.log(`Warning: ${result.warning}`);
    return {
      json: {
        id: service.id,
        ref: service.ref,
        name: service.name,
        deleted: true,
        warning: result.warning,
      },
      text: `Deleted ${label(service)}.`,
    };
  },

  async "route add"(ctx) {
    const service = await resolveService(ctx);
    const r = await ctx.api().services.addRoute.mutate({
      serviceId: service.id,
      host: arg(ctx, "route"),
    });
    if (r.warning) ctx.log(`Warning: ${r.warning}`);
    const tls = r.httpOnly ? "" : ` (tls ${r.tlsStatus})`;
    return {
      json: {
        service,
        route: r.routeString,
        httpOnly: r.httpOnly,
        tlsStatus: r.tlsStatus,
        alreadyExisted: r.alreadyExisted,
        warning: r.warning,
      },
      text: r.alreadyExisted
        ? `${label(service)} already has route ${r.routeString}; nothing changed.`
        : `Route added to ${label(service)}: ${r.routeString}${tls}\nCheck it: siteyctl status ${service.name} --wait`,
    };
  },

  async "route remove"(ctx) {
    const service = await resolveService(ctx);
    const route = arg(ctx, "route");
    const result = await ctx
      .api()
      .services.removeRoute.mutate({ serviceId: service.id, host: route });
    if (result.warning) ctx.log(`Warning: ${result.warning}`);
    const absent = "alreadyAbsent" in result && result.alreadyAbsent;
    return {
      json: { service, route, removed: !absent, warning: result.warning },
      text: absent
        ? `${label(service)} has no route ${route}; nothing changed.`
        : `Removed route ${route} from ${label(service)}.`,
    };
  },

  async "env list"(ctx) {
    const service = await resolveService(ctx);
    if (flag(ctx, "values")) {
      const values = await ctx
        .api()
        .services.envValues.query({ id: service.id });
      return {
        json: { service, values },
        text: Object.entries(values)
          .map(([name, value]) => `${name}=${value}`)
          .join("\n"),
      };
    }
    const view = await ctx.api().services.describe.query({ id: service.id });
    return {
      json: { service, env: view.env },
      text: view.env.length
        ? view.env.join("\n")
        : `${label(service)} has no env vars.`,
    };
  },

  async "env get"(ctx) {
    const service = await resolveService(ctx);
    const result = await ctx
      .api()
      .services.getEnvVar.query({ id: service.id, name: arg(ctx, "VAR") });
    return { json: { service, ...result }, text: result.value };
  },

  async "env set"(ctx) {
    const name = arg(ctx, "VAR");
    if (name.includes("=")) {
      throw new UsageError(
        `Pass only the name; the value comes from stdin so it stays out of shell history:\n  printf %s '<value>' | siteyctl env set ${arg(ctx, "service")} ${name.slice(0, name.indexOf("="))}`,
        ctx.inv.command,
      );
    }
    const service = await resolveService(ctx);
    const value = await ctx.readSecret(`Value for ${name} (hidden): `);
    const result = await ctx
      .api()
      .services.setEnvVar.mutate({ id: service.id, name, value });
    return {
      json: { service, name: result.name, env: result.env },
      text: `Set ${name} on ${label(service)}.\nNot deployed yet: siteyctl deploy ${service.name} --wait`,
    };
  },

  async "env unset"(ctx) {
    const service = await resolveService(ctx);
    const name = arg(ctx, "VAR");
    const result = await ctx
      .api()
      .services.unsetEnvVar.mutate({ id: service.id, name });
    return {
      json: { service, name, removed: result.removed, env: result.env },
      text: result.removed
        ? `Removed ${name} from ${label(service)}.\nNot deployed yet: siteyctl deploy ${service.name} --wait`
        : `${label(service)} has no env var ${name}; nothing changed.`,
    };
  },

  async deploy(ctx) {
    const service = await resolveService(ctx);
    const { deploymentId } = await ctx
      .api()
      .deploy.trigger.mutate({ serviceId: service.id });
    if (!flag(ctx, "wait")) {
      return {
        json: { service, deploymentId, status: "queued" },
        text: `Deploy of ${label(service)} queued (deployment ${deploymentId}).\nFollow it: siteyctl status ${service.name} --wait`,
      };
    }
    ctx.log(
      `Deploy of ${label(service)} queued (deployment ${deploymentId}). Waiting...`,
    );
    const result = await waitOrCheck(ctx, service, deploymentId);
    return { ...result, json: { deploymentId, ...(result.json as object) } };
  },

  async status(ctx) {
    const ref = ctx.inv.args.service;
    if (ref) return waitOrCheck(ctx, await resolveService(ctx, ref), undefined);
    if (flag(ctx, "wait")) {
      throw new UsageError(
        "--wait needs a service: siteyctl status <service> --wait",
        ctx.inv.command,
      );
    }

    const api = ctx.api();
    const services = (await api.services.summaries.query()).filter(
      (s) => !s.protected && s.active,
    );
    const reports = await Promise.all(
      services.map(async (s) => {
        const view = await api.services.describe.query({ id: s.id });
        const d = view.deployments[0];
        const report = await runChecks(
          liveInput(view, d ? { id: d.id, status: d.status } : null),
          ctx.probes,
        );
        return { service: { id: s.id, ref: s.ref, name: s.name }, ...report };
      }),
    );
    const allLive = reports.every((r) => r.live);
    return {
      json: reports,
      text: reports.length
        ? table(
            ["ID", "NAME", "LIVE", "FIRST PROBLEM"],
            reports.map((r) => {
              const problem = r.checks.find((c) => c.state !== "pass");
              return [
                r.service.ref,
                r.service.name,
                r.live ? "yes" : "no",
                problem ? checkLine(problem).trim() : "",
              ];
            }),
          )
        : "No active services.",
      exitCode: allLive ? EXIT.OK : EXIT.ERROR,
    };
  },

  async logs(ctx) {
    const service = await resolveService(ctx);
    const api = ctx.api();
    if (flag(ctx, "runtime")) {
      if (str(ctx, "deployment")) {
        throw new UsageError(
          "--runtime shows the running container; don't combine it with --deployment.",
          ctx.inv.command,
        );
      }
      const view = await api.services.describe.query({ id: service.id });
      if (view.deployMode !== "server") {
        throw new UsageError(
          `${label(service)} is a static site: it has no runtime container. Drop --runtime for build logs.`,
          ctx.inv.command,
        );
      }
      const tail = intOption(ctx, "tail", {
        min: 1,
        max: 2000,
        fallback: 200,
      })!;
      const { lines } = await api.system.getContainerLogs.query({
        containerId: `sitey-service-${service.id}`,
        tail,
      });
      return { json: { service, lines }, text: lines.join("\n") };
    }

    const tail = intOption(ctx, "tail", { min: 1, max: 1000, fallback: 200 })!;
    let deploymentId = str(ctx, "deployment");
    if (deploymentId) {
      const d = await api.deploy.get.query({ id: deploymentId });
      if (d.serviceId !== service.id) {
        throw new CliError(
          `Deployment ${deploymentId} belongs to another service.`,
          EXIT.CONFLICT_OR_NOT_FOUND,
        );
      }
    } else {
      const view = await api.services.describe.query({ id: service.id });
      deploymentId = view.deployments[0]?.id;
      if (!deploymentId) {
        throw new CliError(
          `${label(service)} has no deployments yet.`,
          EXIT.CONFLICT_OR_NOT_FOUND,
        );
      }
    }
    const { lines, status } = await api.deploy.getLogs.query({
      deploymentId,
      tail,
    });
    ctx.log(`Deployment ${deploymentId}: ${status}`);
    return {
      json: { service, deploymentId, status, lines },
      text: lines.join("\n"),
    };
  },

  async domains(ctx) {
    const domains = (await ctx.api().domains.list.query())
      .map((d) => ({
        id: d.id,
        hostname: d.hostname,
        status: d.status,
        letsEncryptEmail: d.letsEncryptEmail,
        siteySubdomainsEnabled: d.siteySubdomainsEnabled,
        routes: d._count.routes,
      }))
      .sort((a, b) => a.hostname.localeCompare(b.hostname));
    return {
      json: domains,
      text: domains.length
        ? table(
            ["HOSTNAME", "STATUS", "ROUTES"],
            domains.map((d) => [d.hostname, d.status, String(d.routes)]),
          )
        : "No domains. Add one with siteyctl domain add <hostname>.",
    };
  },

  async "domain add"(ctx) {
    const hostname = arg(ctx, "hostname");
    const domain = await ctx.api().domains.create.mutate({
      hostname,
      letsEncryptEmail: str(ctx, "email") ?? "",
    });
    if (domain.warning) ctx.log(`Warning: ${domain.warning}`);
    const loopback = ["localhost", "127.0.0.1", "::1"].includes(
      domain.hostname,
    );
    return {
      json: {
        id: domain.id,
        hostname: domain.hostname,
        warning: domain.warning,
      },
      text:
        `Added domain ${domain.hostname}.` +
        (loopback
          ? ""
          : `\nNeeds a human if not done yet: an A record for ${domain.hostname} pointing at the server.`),
    };
  },

  async export(ctx) {
    const { yaml } = await ctx.api().system.exportConfig.query();
    const output = str(ctx, "output");
    if (!output) return { json: { yaml }, text: yaml.replace(/\n$/, "") };
    const file = path.resolve(ctx.cwd, output);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, yaml);
    return { json: { file }, text: `Wrote ${file}` };
  },
};

export function handlerFor(name: string): Handler {
  const handler = handlers[name];
  if (!handler) throw new Error(`No handler for command "${name}"`);
  return handler;
}

export const HANDLED_COMMANDS = Object.keys(handlers);

export function contextFor(
  inv: RunInvocation,
  overrides: Partial<Context> = {},
): Context {
  let selected: { name: string; url: string; api: Api } | undefined;
  const select = () => {
    if (!selected) {
      const { name, profile } = selectProfile(
        loadProfiles(),
        inv.server,
        process.env.SITEY_SERVER,
      );
      selected = {
        name,
        url: profile.url,
        api: createApi(profile.url, profile.token),
      };
    }
    return selected;
  };
  return {
    inv,
    api: () => select().api,
    server: () => ({ name: select().name, url: select().url }),
    log: (line) => process.stderr.write(`${line}\n`),
    readSecret,
    probes: networkProbes,
    // `npm run siteyctl` runs from the repo root; resolve paths against where
    // the user actually invoked npm.
    cwd:
      process.env.npm_lifecycle_event === "siteyctl" && process.env.INIT_CWD
        ? process.env.INIT_CWD
        : process.cwd(),
    ...overrides,
  };
}

/** Reads a secret: hidden prompt in a terminal, all of stdin when piped. */
async function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks)
      .toString("utf8")
      .replace(/\r?\n$/, "");
  }
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const done = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          done();
          resolve(value);
          return;
        }
        if (ch === "" || ch === "") {
          done();
          reject(new CliError("Cancelled."));
          return;
        }
        if (ch === "" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}
