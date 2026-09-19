import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { customAlphabet, nanoid } from "nanoid";
import { router, settledProcedure } from "../trpc.ts";
import { db } from "../lib/db.ts";
import { generateWebhookSecret } from "../services/crypto.ts";
import {
  reloadCaddy,
  isDomainStatusStale,
  scheduleDomainStatusRefresh,
  probeRouteTls,
  scheduleRouteTlsProbe,
  validateStaticCaddyConfig,
} from "../services/caddy.ts";
import { STATIC_ROUTING_MODES } from "../services/staticRouting.ts";
import { enqueueDeployment, parseEnvString } from "../services/deployment.ts";
import {
  stopAndRemoveContainer,
  pruneServiceImages,
} from "../services/docker.ts";
import { serviceRootPath, serviceRepoPath } from "../services/git.ts";
import {
  normalizeSiteUrl,
  resolvePublicSiteUrl,
  isLoopbackHost,
} from "../services/siteUrl.ts";
import {
  formatServiceRef,
  parseServiceRef,
  serviceNameSchema,
} from "../lib/serviceRef.ts";
import { outputDirSchema } from "../lib/outputDir.ts";
import { formatRouteString } from "../lib/routeString.ts";
import {
  EnvFileError,
  envVarNames,
  setEnvVar,
  unsetEnvVar,
} from "../lib/envFile.ts";

import type { Prisma } from "../generated/prisma/client.ts";
import {
  resolveRouteInput,
  routesForHost,
  assertRouteAllowed,
  assertCompatibleHost,
  insertResolvedRoute,
  insertDomainlessRoute,
  isUniqueViolation,
  parseRoute,
} from "../services/routes.ts";

async function routingWarning(): Promise<string | null> {
  return reloadCaddy().then(
    () => null,
    (err) => {
      console.error("[services] Caddy configuration delivery failed:", err);
      return `Configuration saved, but Caddy reload failed: ${String(err)}. Retry the command to apply routing.`;
    },
  );
}

async function editEnv(
  id: number,
  edit: (raw: string) => { envVars: string; removed?: boolean },
) {
  // Compare-and-swap protects different variables from lost updates, including
  // races with the UI's whole-file editor. Re-read after every conflict.
  for (let attempt = 0; attempt < 20; attempt++) {
    const service = await findServiceOrThrow(id);
    let result;
    try {
      result = edit(service.envVars);
    } catch (err) {
      if (err instanceof EnvFileError)
        throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
      throw err;
    }
    const updated = await db.service.updateMany({
      where: { id, envVars: service.envVars },
      data: { envVars: result.envVars },
    });
    if (updated.count) return result;
  }
  throw new TRPCError({
    code: "CONFLICT",
    message: "Environment changed repeatedly; retry this edit.",
  });
}

const SUBDOMAIN_LABEL_REGEX = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const randomSubdomainSuffix = customAlphabet(
  "abcdefghijklmnopqrstuvwxyz0123456789",
  5,
);

function isWildcardDomain(hostname: string): boolean {
  return hostname.startsWith("*.");
}

async function resolveWebhookBaseUrl(hostname?: string): Promise<string> {
  if (hostname) {
    const fromDomain = normalizeSiteUrl(`https://${hostname}`);
    if (!fromDomain) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Invalid domain hostname: ${hostname}`,
      });
    }
    return fromDomain;
  }

  const resolved = await resolvePublicSiteUrl();
  if (!resolved.effectiveUrl) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Public Site URL is not configured. Configure it in Settings or enable Sitey subdomains on a wildcard domain.",
    });
  }
  return resolved.effectiveUrl;
}

function slugifySubdomainSeed(input: string): string {
  const cleaned = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "service";
}

function buildSubdomainCandidate(seed: string): string {
  const suffix = randomSubdomainSuffix();
  const maxSeedLength = 63 - suffix.length - 1;
  const trimmedSeed = seed
    .slice(0, Math.max(1, maxSeedLength))
    .replace(/-+$/g, "");
  const finalSeed = trimmedSeed || "service";
  return `${finalSeed}-${suffix}`;
}

async function generateUniqueSubdomain(
  domainId: number,
  serviceName: string,
): Promise<string> {
  const seed = slugifySubdomainSeed(serviceName);
  for (let i = 0; i < 20; i += 1) {
    const candidate = buildSubdomainCandidate(seed);
    const existing = await db.serviceRoute.findFirst({
      where: { domainId, subdomain: candidate },
      select: { id: true },
    });
    if (!existing) return candidate;
  }
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "Could not allocate a unique subdomain. Please retry.",
  });
}

/**
 * Find or create a Repo record for the given GitHub owner/name.
 */
async function findOrCreateRepo(
  repoOwner: string,
  repoName: string,
  githubMode: string,
  store: Prisma.TransactionClient = db,
): Promise<{ id: number }> {
  // SQLite LIKE is case-insensitive by default for ASCII
  const allRepos = await store.repo.findMany({
    where: { repoOwner, repoName },
    select: { id: true },
  });
  // Fallback: try case-insensitive match manually
  if (allRepos.length === 0) {
    const all = await store.repo.findMany({
      select: { id: true, repoOwner: true, repoName: true },
    });
    const match = all.find(
      (r) =>
        r.repoOwner.toLowerCase() === repoOwner.toLowerCase() &&
        r.repoName.toLowerCase() === repoName.toLowerCase(),
    );
    if (match) return { id: match.id };
  } else {
    return allRepos[0];
  }
  return store.repo.create({
    data: { name: repoName, repoOwner, repoName, githubMode },
  });
}

/**
 * Checks routing settings as they will be after a write. A custom fragment is
 * validated (scope check, then Caddy's adapter) whenever it would be saved or
 * switched on, so nothing that can't load is ever stored as the active config.
 */
async function assertStaticRouting(
  next: {
    id: number;
    outputDir: string;
    staticRoutingMode: string;
    staticCaddyConfig: string;
  },
  changed: { mode: boolean; config: boolean },
) {
  const custom = next.staticRoutingMode === "caddy";
  if (changed.config && next.staticCaddyConfig.trim() && !custom)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        'staticCaddyConfig only applies with staticRoutingMode "caddy". Set both together.',
    });
  if (!custom || !(changed.mode || changed.config)) return;
  const result = await validateStaticCaddyConfig(next.staticCaddyConfig, next);
  if (!result.ok)
    throw new TRPCError({
      code: result.unreachable ? "PRECONDITION_FAILED" : "BAD_REQUEST",
      message: `${result.message.replace(/\.?$/, ".")} Nothing was saved${result.unreachable ? "; retry when Caddy is running." : "."}`,
    });
}

function nameTaken(name: string): TRPCError {
  return new TRPCError({
    code: "CONFLICT",
    message: `A service named "${name}" already exists. Names are unique; pick another or rename the existing service.`,
  });
}

async function findServiceOrThrow(id: number) {
  const service = await db.service.findUnique({ where: { id } });
  if (!service)
    throw new TRPCError({ code: "NOT_FOUND", message: "Service not found" });
  return service;
}

type RouteForView = {
  domain: { hostname: string } | null;
  subdomain: string;
  pathPrefix: string;
  httpOnly: boolean;
};

/** Routes as the strings siteyctl accepts; the domainless catch-all is "(catch-all)". */
function routeStrings(routes: RouteForView[]): string[] {
  return routes
    .map((r) => formatRouteString(r) ?? "(catch-all)")
    .sort((a, b) => a.localeCompare(b));
}

function repoLabel(repo: {
  repoOwner: string;
  repoName: string;
  name: string;
}) {
  return repo.repoOwner && repo.repoName
    ? `${repo.repoOwner}/${repo.repoName}`
    : repo.name;
}

export const servicesRouter = router({
  list: settledProcedure.query(() =>
    db.service.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        repo: true,
        routes: { include: { domain: true } },
        deployments: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    }),
  ),

  get: settledProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ input }) => {
      const service = await db.service.findUnique({
        where: { id: input.id },
        include: {
          repo: true,
          routes: { include: { domain: true } },
          deployments: { orderBy: { createdAt: "desc" }, take: 5 },
        },
      });
      if (!service)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Service not found",
        });

      // Trigger background TLS status refresh for stale domains so the
      // frontend gets an up-to-date status on the next fetch.
      for (const route of service.routes) {
        if (route.domain && isDomainStatusStale(route.domain.statusCheckedAt)) {
          scheduleDomainStatusRefresh(route.domain);
        }
        // Probe unchecked route TLS in the background so the next
        // fetch returns a verified status.
        if (
          route.domain &&
          !route.httpOnly &&
          route.tlsStatus === "unchecked"
        ) {
          scheduleRouteTlsProbe(route);
        }
      }

      return service;
    }),

  // ── Views for siteyctl ────────────────────────────────────────────────────
  // Route strings and env var names only: env values never leave through these.

  /** Resolves a `<service>` reference: current name, `service-42`, or `42`. */
  resolve: settledProcedure
    .input(z.object({ ref: z.string().min(1) }))
    .query(async ({ input }) => {
      const ref = parseServiceRef(input.ref);
      const service = await db.service.findUnique({
        where: "id" in ref ? { id: ref.id } : { name: ref.name },
        select: { id: true, name: true },
      });
      if (!service)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `No service ${"id" in ref ? `with id ${ref.id}` : `named "${ref.name}"`}. List services with siteyctl services.`,
        });
      return { ...service, ref: formatServiceRef(service.id) };
    }),

  summaries: settledProcedure.query(async () => {
    const services = await db.service.findMany({
      orderBy: { id: "asc" },
      include: {
        repo: true,
        routes: { include: { domain: true } },
        deployments: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });
    return services.map((s) => ({
      id: s.id,
      ref: formatServiceRef(s.id),
      name: s.name,
      repo: repoLabel(s.repo),
      deployMode: s.deployMode,
      status: s.status,
      active: s.active,
      protected: s.protected,
      routes: routeStrings(s.routes),
      latestDeployment: s.deployments[0]
        ? {
            id: s.deployments[0].id,
            status: s.deployments[0].status,
            createdAt: s.deployments[0].createdAt,
          }
        : null,
    }));
  }),

  describe: settledProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ input }) => {
      const s = await db.service.findUnique({
        where: { id: input.id },
        include: {
          repo: true,
          routes: { include: { domain: true } },
          deployments: { orderBy: { createdAt: "desc" }, take: 5 },
        },
      });
      if (!s)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Service not found",
        });
      return {
        id: s.id,
        ref: formatServiceRef(s.id),
        name: s.name,
        repo: repoLabel(s.repo),
        githubMode: s.repo.githubMode,
        branch: s.branch,
        deployMode: s.deployMode,
        buildMode: s.buildMode,
        buildImage: s.buildImage,
        buildCommand: s.buildCommand,
        outputDir: s.outputDir,
        staticRoutingMode: s.staticRoutingMode,
        staticCaddyConfig: s.staticCaddyConfig,
        dockerfilePath: s.dockerfilePath,
        serverRunCommand: s.serverRunCommand,
        containerPort: s.containerPort,
        status: s.status,
        active: s.active,
        protected: s.protected,
        env: envVarNames(s.envVars),
        routes: s.routes
          .map((r) => ({
            route: formatRouteString(r) ?? "(catch-all)",
            httpOnly: r.httpOnly,
            tlsStatus: r.tlsStatus,
          }))
          .sort((a, b) => a.route.localeCompare(b.route)),
        deployments: s.deployments.map((d) => ({
          id: d.id,
          status: d.status,
          triggeredBy: d.triggeredBy,
          commitSha: d.commitSha,
          commitMessage: d.commitMessage,
          createdAt: d.createdAt,
          startedAt: d.startedAt,
          finishedAt: d.finishedAt,
        })),
      };
    }),

  /**
   * Dry run of addRoute({ host }): which Domain row the route string lands on,
   * and whether it's free. Lets siteyctl validate --route flags before creating
   * a service.
   */
  checkRoute: settledProcedure
    .input(
      z.object({
        route: z.string().min(1),
        serviceId: z.number().int().optional(),
      }),
    )
    .query(async ({ input }) => {
      const resolved = await resolveRouteInput(input.route);
      await assertRouteAllowed(
        resolved.host,
        resolved.pathPrefix,
        resolved.httpOnly,
      );
      const hostRoutes = await routesForHost(resolved.host);
      assertCompatibleHost(hostRoutes, resolved.httpOnly);
      const existing = hostRoutes.find(
        (r) => r.pathPrefix === resolved.pathPrefix,
      );
      return {
        route: resolved.route,
        domain: resolved.domain.hostname,
        subdomain: resolved.subdomain,
        pathPrefix: resolved.pathPrefix,
        httpOnly: resolved.httpOnly,
        takenBy:
          existing && existing.serviceId !== input.serviceId
            ? {
                id: existing.service.id,
                name: existing.service.name,
                ref: formatServiceRef(existing.service.id),
              }
            : null,
      };
    }),

  create: settledProcedure
    .input(
      z.object({
        name: serviceNameSchema,
        routes: z.array(z.string().min(1)).default([]),
        repoOwner: z.string().min(1),
        repoName: z.string().min(1),
        branch: z.string().default("main"),
        deployMode: z.enum(["server", "static"]).default("server"),
        buildCommand: z.string().default(""),
        outputDir: outputDirSchema.default("dist"),
        staticRoutingMode: z.enum(STATIC_ROUTING_MODES).default("spa"),
        staticCaddyConfig: z.string().max(65536).default(""),
        buildImage: z.string().max(200).default(""),
        serverRunCommand: z.string().default(""),
        buildMode: z.enum(["auto", "dockerfile"]).default("auto"),
        dockerfilePath: z.string().default(""),
        containerPort: z.number().int().min(1).max(65535).default(3000),
        envVars: z.string().default(""),
        githubMode: z.enum(["webhook", "app"]).default("webhook"),
      }),
    )
    .mutation(async ({ input }) => {
      const {
        repoOwner,
        repoName,
        githubMode,
        routes: routeInputs,
        ...serviceData
      } = input;
      // The id only names the synthetic validation site; any number works.
      await assertStaticRouting(
        { id: 0, ...serviceData },
        { mode: true, config: true },
      );
      const initialRoutes = await Promise.all(
        routeInputs.map((route) => resolveRouteInput(route)),
      );
      for (const route of initialRoutes)
        await assertRouteAllowed(route.host, route.pathPrefix, route.httpOnly);
      const result = await db.$transaction(async (tx) => {
        // Checked up front (the unique index is the real guard) so a retried
        // create doesn't touch the repo's integration settings first.
        const nameInUse = await tx.service.findUnique({
          where: { name: input.name },
          select: { id: true },
        });
        if (nameInUse) throw nameTaken(input.name);

        // Find or create the Repo
        const repo = await findOrCreateRepo(
          repoOwner,
          repoName,
          githubMode,
          tx,
        );

        // Update repo's githubMode if it changed
        await tx.repo.update({
          where: { id: repo.id },
          data: { githubMode },
        });

        let service;
        try {
          service = await tx.service.create({
            data: {
              ...serviceData,
              repoId: repo.id,
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) throw nameTaken(input.name);
          throw err;
        }

        // Create a HookEndpoint for webhook-mode repos (if one doesn't already exist)
        if (githubMode === "webhook") {
          const existingEndpoint = await tx.hookEndpoint.findFirst({
            where: { repoId: repo.id, sourceType: "github_webhook" },
          });
          if (!existingEndpoint) {
            const secret = generateWebhookSecret();
            await tx.hookEndpoint.create({
              data: {
                publicId: nanoid(24),
                secret,
                sourceType: "github_webhook",
                repoId: repo.id,
              },
            });
          }
        }

        const routes = [];
        for (const resolved of initialRoutes)
          routes.push(await insertResolvedRoute(tx, service.id, resolved));
        const deployment = await tx.deployment.create({
          data: {
            serviceId: service.id,
            status: "queued",
            triggeredBy: "manual",
          },
        });
        return { service, deployment, routes };
      });
      enqueueDeployment(result.service, result.deployment);
      const warning = result.routes.length ? await routingWarning() : null;
      return {
        id: result.service.id,
        name: result.service.name,
        deploymentId: result.deployment.id,
        routes: result.routes.map((r) => ({
          route: formatRouteString(r)!,
          tlsStatus: r.tlsStatus,
          alreadyExisted: r.alreadyExisted,
        })),
        warning,
      };
    }),

  update: settledProcedure
    .input(
      z.object({
        id: z.number().int(),
        // Renames update the row in place: the id, data directory, deployments
        // and analytics stay attached.
        name: serviceNameSchema.optional(),
        branch: z.string().optional(),
        deployMode: z.enum(["server", "static"]).optional(),
        buildCommand: z.string().optional(),
        outputDir: outputDirSchema.optional(),
        // Routing settings apply with a Caddy reload; no redeploy.
        staticRoutingMode: z.enum(STATIC_ROUTING_MODES).optional(),
        staticCaddyConfig: z.string().max(65536).optional(),
        buildImage: z.string().max(200).optional(),
        serverRunCommand: z.string().optional(),
        buildMode: z.enum(["auto", "dockerfile"]).optional(),
        dockerfilePath: z.string().optional(),
        containerPort: z.number().int().min(1).max(65535).optional(),
        envVars: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { id, ...rest } = input;
      const current = await findServiceOrThrow(id);
      const next = { ...current, ...rest };
      // Explicit requests also retry delivery after an earlier reload failed.
      const routingRequested =
        rest.staticRoutingMode !== undefined ||
        rest.staticCaddyConfig !== undefined ||
        (next.deployMode === "static" && rest.outputDir !== undefined);
      const routingChanged = {
        mode: next.staticRoutingMode !== current.staticRoutingMode,
        config: next.staticCaddyConfig !== current.staticCaddyConfig,
      };
      await assertStaticRouting(next, routingChanged);
      try {
        const updated = await db.service.update({
          // Compare-and-swap on the validated routing settings, so a
          // concurrent edit can't swap in a config that wasn't checked.
          where: {
            id,
            staticRoutingMode: current.staticRoutingMode,
            staticCaddyConfig: current.staticCaddyConfig,
          },
          data: rest,
        });
        const warning = routingRequested ? await routingWarning() : null;
        let outputDirectoryWarning: string | undefined;
        if (routingRequested && updated.deployMode === "static") {
          const outputPath = path.join(serviceRepoPath(id), updated.outputDir);
          try {
            if (!(await fs.promises.stat(outputPath)).isDirectory())
              outputDirectoryWarning = `Output directory "${updated.outputDir || "."}" is not a directory. Correct the folder or deploy to create it; static files cannot be served from it yet.`;
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            outputDirectoryWarning =
              code === "ENOENT" || code === "ENOTDIR"
                ? `Output directory "${updated.outputDir || "."}" does not exist yet. Correct the folder or deploy to create it; static files cannot be served from it yet.`
                : `Could not check output directory "${updated.outputDir || "."}": ${String(err)}`;
          }
        }
        // Mutations acknowledge edits. Secret disclosure requires an explicit read.
        return {
          id: updated.id,
          name: updated.name,
          warning,
          ...(outputDirectoryWarning ? { outputDirectoryWarning } : {}),
        };
      } catch (err) {
        if (
          err instanceof Error &&
          "code" in err &&
          (err as { code?: string }).code === "P2025"
        )
          throw new TRPCError({
            code: "CONFLICT",
            message: "Routing settings changed while saving; retry.",
          });
        if (rest.name && isUniqueViolation(err)) throw nameTaken(rest.name);
        throw err;
      }
    }),

  // ── Env vars by name ──────────────────────────────────────────────────────
  // Edit one entry atomically. Values are readable by administrators through
  // explicit env reads; routine mutation responses omit them.

  setEnvVar: settledProcedure
    .input(
      z.object({
        id: z.number().int(),
        name: z.string().min(1),
        value: z.string(),
      }),
    )
    .mutation(async ({ input }) => {
      const { envVars } = await editEnv(input.id, (raw) => ({
        envVars: setEnvVar(raw, input.name, input.value),
      }));
      return { ok: true, name: input.name, env: envVarNames(envVars) };
    }),

  unsetEnvVar: settledProcedure
    .input(z.object({ id: z.number().int(), name: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const result = await editEnv(input.id, (raw) =>
        unsetEnvVar(raw, input.name),
      );
      return {
        ok: true,
        name: input.name,
        removed: result.removed ?? false,
        env: envVarNames(result.envVars),
      };
    }),

  envValues: settledProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ input }) =>
      parseEnvString((await findServiceOrThrow(input.id)).envVars),
    ),

  getEnvVar: settledProcedure
    .input(
      z.object({
        id: z.number().int(),
        name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
      }),
    )
    .query(async ({ input }) => {
      const values = parseEnvString(
        (await findServiceOrThrow(input.id)).envVars,
      );
      if (!Object.hasOwn(values, input.name))
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `No environment variable named ${input.name}.`,
        });
      return { name: input.name, value: values[input.name] };
    }),

  delete: settledProcedure
    .input(
      z.object({
        id: z.number().int(),
        // When given, must equal the service's current name. siteyctl always
        // sends it, so a rename between resolving and deleting can't delete
        // the wrong thing.
        confirmName: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const service = await findServiceOrThrow(input.id);
      if (service.protected)
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "This service cannot be deleted",
        });
      if (input.confirmName !== undefined && input.confirmName !== service.name)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Confirmation "${input.confirmName}" doesn't match the service name "${service.name}".`,
        });

      // Stop & remove Docker container (best-effort)
      const noop = () => {};
      await stopAndRemoveContainer(`sitey-service-${service.id}`, noop);
      await stopAndRemoveContainer(`sitey-project-${service.id}`, noop);
      await stopAndRemoveContainer(`sitey-${service.id}`, noop);
      await pruneServiceImages(service.id, [], noop).catch(noop);

      // Delete service from DB (cascades to routes/deployments)
      await db.service.delete({ where: { id: input.id } });

      // Remove service files on disk (best-effort)
      const rootPath = serviceRootPath(service.id);
      fs.rm(rootPath, { recursive: true, force: true }, () => {});

      // Reload Caddy so the route is removed
      return { ok: true, warning: await routingWarning() };
    }),

  // ── Activate / Deactivate ─────────────────────────────────────────────────

  deactivate: settledProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ input }) => {
      const service = await db.service.findUnique({ where: { id: input.id } });
      if (!service)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Service not found",
        });
      if (!service.active) return { ok: true, warning: await routingWarning() };

      // Stop & remove Docker container (best-effort, server services only)
      if (service.deployMode === "server") {
        const noop = () => {};
        await stopAndRemoveContainer(`sitey-service-${service.id}`, noop);
        await stopAndRemoveContainer(`sitey-project-${service.id}`, noop);
        await stopAndRemoveContainer(`sitey-${service.id}`, noop);
      }

      await db.service.update({
        where: { id: input.id },
        data: {
          active: false,
          status: "stopped",
          containerId: null,
          containerName: null,
        },
      });

      // Reload Caddy so routes stop serving traffic
      return { ok: true, warning: await routingWarning() };
    }),

  activate: settledProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ input }) => {
      const service = await db.service.findUnique({ where: { id: input.id } });
      if (!service)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Service not found",
        });
      if (service.active) return { ok: true, warning: await routingWarning() };

      await db.service.update({
        where: { id: input.id },
        data: { active: true },
      });

      // Put the routes back in Caddy. Static sites serve again right away;
      // server apps show the pending page until their next deploy.
      return { ok: true, warning: await routingWarning() };
    }),

  // ── Routes ─────────────────────────────────────────────────────────────────

  addRoute: settledProcedure
    .input(
      z.object({
        serviceId: z.number().int(),
        // Either a route string, `[http://]host[/pathPrefix]`, resolved to a
        // Domain row by lib/routeString.ts (siteyctl)…
        host: z.string().min(1).optional(),
        // …or the explicit tuple (the UI).
        domainId: z.number().int().optional(),
        pathPrefix: z.string().optional(),
        subdomain: z.string().optional(),
        httpOnly: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const service = await db.service.findUnique({
        where: { id: input.serviceId },
        select: { id: true, name: true },
      });
      if (!service)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Service not found",
        });

      let domain: { id: number; hostname: string } | null = null;
      let subdomain: string;
      let pathPrefix: string;
      let httpOnly: boolean;

      if (input.host !== undefined) {
        if (
          input.domainId !== undefined ||
          input.subdomain ||
          input.pathPrefix ||
          input.httpOnly !== undefined
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "host can't be combined with domainId, subdomain, pathPrefix or httpOnly: the route string carries all of them.",
          });
        }
        const resolved = await resolveRouteInput(input.host);
        ({ domain, subdomain, pathPrefix, httpOnly } = resolved);
      } else {
        pathPrefix = input.pathPrefix ?? "";
        httpOnly = input.httpOnly ?? false;
        if (input.domainId) {
          domain = await db.domain.findUnique({
            where: { id: input.domainId },
            select: { id: true, hostname: true },
          });
          if (!domain)
            throw new TRPCError({
              code: "NOT_FOUND",
              message: "Domain not found",
            });
        }

        subdomain = (input.subdomain ?? "").trim().toLowerCase();
        if (domain && isWildcardDomain(domain.hostname)) {
          if (!subdomain) {
            subdomain = await generateUniqueSubdomain(domain.id, service.name);
          } else if (!SUBDOMAIN_LABEL_REGEX.test(subdomain)) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                "Subdomain must be a valid DNS label (lowercase letters, numbers, hyphens).",
            });
          }
        } else {
          if (subdomain) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                "Subdomain can only be set when using a wildcard domain.",
            });
          }
          subdomain = "";
        }
      }

      let route;
      if (domain) {
        const parsed = parseRoute(
          formatRouteString({ domain, subdomain, pathPrefix, httpOnly })!,
        );
        await assertRouteAllowed(parsed.host, parsed.pathPrefix, httpOnly);
        const resolved = {
          ...parsed,
          domain,
          subdomain,
          route: formatRouteString({
            domain,
            subdomain,
            pathPrefix: parsed.pathPrefix,
            httpOnly,
          })!,
        };
        route = await db.$transaction((tx) =>
          insertResolvedRoute(tx, service.id, resolved),
        );
      } else {
        pathPrefix = parseRoute(`http://localhost${pathPrefix}`).pathPrefix;
        const prefix = pathPrefix;
        route = await db.$transaction((tx) =>
          insertDomainlessRoute(tx, service.id, prefix, httpOnly),
        );
      }
      // An idempotent retry must still deliver the saved configuration.
      const warning = await routingWarning();
      if (route.domain && !route.httpOnly && !warning)
        scheduleRouteTlsProbe(route);
      return { ...route, routeString: formatRouteString(route), warning };
    }),

  removeRoute: settledProcedure
    .input(
      z.union([
        z.object({ routeId: z.string() }),
        // siteyctl: the route string, resolved the same way as addRoute.
        z.object({ serviceId: z.number().int(), host: z.string().min(1) }),
      ]),
    )
    .mutation(async ({ input }) => {
      let route;
      if ("routeId" in input) {
        route = await db.serviceRoute.findUnique({
          where: { id: input.routeId },
        });
      } else {
        const parsed = parseRoute(input.host);
        await findServiceOrThrow(input.serviceId);
        // All routes on a host share one HTTP-only setting, so the scheme is not
        // part of the route's identity: `localhost/app` removes `http://localhost/app`.
        route = (await routesForHost(parsed.host)).find(
          (r) =>
            r.serviceId === input.serviceId &&
            r.pathPrefix === parsed.pathPrefix,
        );
        if (!route)
          return {
            ok: true,
            alreadyAbsent: true,
            warning: await routingWarning(),
          };
      }
      if (!route)
        throw new TRPCError({ code: "NOT_FOUND", message: "Route not found" });
      if (route.protected)
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "This route cannot be removed",
        });
      await db.serviceRoute.delete({ where: { id: route.id } });
      return { ok: true, warning: await routingWarning() };
    }),

  retryRouteTls: settledProcedure
    .input(z.object({ routeId: z.string() }))
    .mutation(async ({ input }) => {
      const route = await db.serviceRoute.findUnique({
        where: { id: input.routeId },
        include: { domain: true },
      });
      if (!route)
        throw new TRPCError({ code: "NOT_FOUND", message: "Route not found" });
      if (!route.domain)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Route has no domain",
        });
      if (route.httpOnly)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "HTTP-only routes do not support TLS checks.",
        });
      const tlsStatus = await probeRouteTls(route);
      return { tlsStatus };
    }),

  // ── Webhook ────────────────────────────────────────────────────────────────

  rotateWebhookSecret: settledProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ input }) => {
      // Find the HookEndpoint for this service's repo
      const service = await db.service.findUniqueOrThrow({
        where: { id: input.id },
        select: { repoId: true },
      });
      const endpoint = await db.hookEndpoint.findFirst({
        where: { repoId: service.repoId, sourceType: "github_webhook" },
      });
      if (!endpoint)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No webhook endpoint found for this service",
        });
      const secret = generateWebhookSecret();
      await db.hookEndpoint.update({
        where: { id: endpoint.id },
        data: { secret },
      });
      return { webhookSecret: secret };
    }),

  getWebhookInfo: settledProcedure
    .input(
      z.object({ id: z.number().int(), domainId: z.number().int().optional() }),
    )
    .query(async ({ input }) => {
      const service = await db.service.findUniqueOrThrow({
        where: { id: input.id },
        include: { repo: true },
      });

      // Find the HookEndpoint for this service
      const endpoint = await db.hookEndpoint.findFirst({
        where: { repoId: service.repoId, sourceType: "github_webhook" },
      });

      const domains = await db.domain.findMany({
        select: { id: true, hostname: true },
        orderBy: { createdAt: "asc" },
      });
      const webhookDomains = domains.filter(
        (d: { id: number; hostname: string }) => !isWildcardDomain(d.hostname),
      );
      const chosen = input.domainId
        ? webhookDomains.find(
            (d: { id: number; hostname: string }) => d.id === input.domainId,
          )
        : null;
      const fallbackHostname =
        webhookDomains.length === 1 ? webhookDomains[0].hostname : undefined;
      const baseUrl = chosen?.hostname
        ? await resolveWebhookBaseUrl(chosen.hostname)
        : await resolveWebhookBaseUrl().catch((err) => {
            if (fallbackHostname)
              return resolveWebhookBaseUrl(fallbackHostname);
            throw err;
          });

      // Build the hook URL using the endpoint's publicId
      if (!endpoint) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No hook endpoint found for this service",
        });
      }
      const webhookUrl = `${baseUrl}/api/hook/${endpoint.publicId}`;

      return {
        webhookUrl,
        webhookSecret: endpoint?.secret ?? null,
        githubMode: service.repo.githubMode,
        domains: webhookDomains,
      };
    }),
});
