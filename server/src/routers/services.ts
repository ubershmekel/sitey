import fs from "node:fs";
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
} from "../services/caddy.ts";
import { enqueueDeployment } from "../services/deployment.ts";
import {
  stopAndRemoveContainer,
  pruneServiceImages,
} from "../services/docker.ts";
import { serviceRootPath } from "../services/git.ts";
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
import {
  formatRouteString,
  parseRouteString,
  resolveRouteHost,
  RouteStringError,
} from "../lib/routeString.ts";
import {
  EnvFileError,
  envVarNames,
  setEnvVar,
  unsetEnvVar,
} from "../lib/envFile.ts";

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
): Promise<{ id: number }> {
  // SQLite LIKE is case-insensitive by default for ASCII
  const allRepos = await db.repo.findMany({
    where: { repoOwner, repoName },
    select: { id: true },
  });
  // Fallback: try case-insensitive match manually
  if (allRepos.length === 0) {
    const all = await db.repo.findMany({
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
  return db.repo.create({
    data: { name: repoName, repoOwner, repoName, githubMode },
  });
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string }).code === "P2002";
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

/** Resolves a route string (`[http://]host[/path]`) to its Domain row. */
async function resolveRouteInput(route: string) {
  let parsed;
  try {
    parsed = parseRouteString(route);
  } catch (err) {
    if (err instanceof RouteStringError)
      throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
    throw err;
  }
  const domains = await db.domain.findMany({
    select: { id: true, hostname: true },
  });
  const match = resolveRouteHost(parsed.host, domains);
  if (!match) {
    const dot = parsed.host.indexOf(".");
    const wildcardHint =
      dot === -1 ? "" : ` or '*.${parsed.host.slice(dot + 1)}'`;
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `No domain covers ${parsed.host}. Add one with siteyctl domain add ${parsed.host}${wildcardHint} (and point its DNS at this server).`,
    });
  }
  return {
    domain: match.domain,
    subdomain: match.subdomain,
    pathPrefix: parsed.pathPrefix,
    httpOnly: parsed.httpOnly,
    route: formatRouteString({
      domain: match.domain,
      subdomain: match.subdomain,
      pathPrefix: parsed.pathPrefix,
      httpOnly: parsed.httpOnly,
    })!,
  };
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
      const existing = await db.serviceRoute.findFirst({
        where: {
          domainId: resolved.domain.id,
          subdomain: resolved.subdomain,
          pathPrefix: resolved.pathPrefix,
        },
        include: { service: { select: { id: true, name: true } } },
      });
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
        repoOwner: z.string().min(1),
        repoName: z.string().min(1),
        branch: z.string().default("main"),
        deployMode: z.enum(["server", "static"]).default("server"),
        buildCommand: z.string().default(""),
        outputDir: z.string().default("dist"),
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
      const { repoOwner, repoName, githubMode, ...serviceData } = input;

      // Checked up front (the unique index is the real guard) so a retried
      // create doesn't touch the repo's integration settings first.
      const nameInUse = await db.service.findUnique({
        where: { name: input.name },
        select: { id: true },
      });
      if (nameInUse) throw nameTaken(input.name);

      // Find or create the Repo
      const repo = await findOrCreateRepo(repoOwner, repoName, githubMode);

      // Update repo's githubMode if it changed
      await db.repo.update({
        where: { id: repo.id },
        data: { githubMode },
      });

      let service;
      try {
        service = await db.service.create({
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
        const existingEndpoint = await db.hookEndpoint.findFirst({
          where: { repoId: repo.id, sourceType: "github_webhook" },
        });
        if (!existingEndpoint) {
          const secret = generateWebhookSecret();
          await db.hookEndpoint.create({
            data: {
              publicId: nanoid(24),
              secret,
              sourceType: "github_webhook",
              repoId: repo.id,
            },
          });
        }
      }

      const deployment = await db.deployment.create({
        data: {
          serviceId: service.id,
          status: "queued",
          triggeredBy: "manual",
        },
      });
      enqueueDeployment(service, deployment);

      return { ...service, deploymentId: deployment.id };
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
        outputDir: z.string().optional(),
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
      await findServiceOrThrow(id);
      try {
        return await db.service.update({
          where: { id },
          data: rest,
        });
      } catch (err) {
        if (rest.name && isUniqueViolation(err)) throw nameTaken(rest.name);
        throw err;
      }
    }),

  // ── Env vars by name ──────────────────────────────────────────────────────
  // Edit one entry of the .env string. Values are write-only: responses carry
  // names, never values. Saving doesn't redeploy (matches the UI).

  setEnvVar: settledProcedure
    .input(
      z.object({
        id: z.number().int(),
        name: z.string().min(1),
        value: z.string(),
      }),
    )
    .mutation(async ({ input }) => {
      const service = await findServiceOrThrow(input.id);
      let envVars;
      try {
        envVars = setEnvVar(service.envVars, input.name, input.value);
      } catch (err) {
        if (err instanceof EnvFileError)
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        throw err;
      }
      await db.service.update({ where: { id: input.id }, data: { envVars } });
      return { ok: true, name: input.name, env: envVarNames(envVars) };
    }),

  unsetEnvVar: settledProcedure
    .input(z.object({ id: z.number().int(), name: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const service = await findServiceOrThrow(input.id);
      let result;
      try {
        result = unsetEnvVar(service.envVars, input.name);
      } catch (err) {
        if (err instanceof EnvFileError)
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        throw err;
      }
      if (result.removed) {
        await db.service.update({
          where: { id: input.id },
          data: { envVars: result.envVars },
        });
      }
      return {
        ok: true,
        name: input.name,
        removed: result.removed,
        env: envVarNames(result.envVars),
      };
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
      reloadCaddy().catch((err) =>
        console.error("[services] Caddy reload failed after delete:", err),
      );

      return { ok: true };
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
      if (!service.active) return { ok: true };

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
      reloadCaddy().catch((err) =>
        console.error("[services] Caddy reload failed after deactivate:", err),
      );

      return { ok: true };
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
      if (service.active) return { ok: true };

      await db.service.update({
        where: { id: input.id },
        data: { active: true },
      });

      // Put the routes back in Caddy. Static sites serve again right away;
      // server apps show the pending page until their next deploy.
      reloadCaddy().catch((err) =>
        console.error("[services] Caddy reload failed after activate:", err),
      );

      return { ok: true };
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

      if (domain && isLoopbackHost(domain.hostname) && !httpOnly) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            input.host !== undefined
              ? `localhost routes are HTTP-only. Use http://${domain.hostname}${pathPrefix}`
              : "localhost routes must be created as HTTP-only.",
        });
      }

      if (domain) {
        // Adding a route this service already has is a no-op, so reruns are safe.
        const existing = await db.serviceRoute.findFirst({
          where: { domainId: domain.id, subdomain, pathPrefix },
          include: {
            domain: true,
            service: { select: { id: true, name: true } },
          },
        });
        if (existing) {
          const { service: owner, ...existingRoute } = existing;
          const label = formatRouteString(existingRoute);
          if (owner.id !== service.id) {
            throw new TRPCError({
              code: "CONFLICT",
              message: `${label} is already routed to service "${owner.name}" (${formatServiceRef(owner.id)}). Remove it there first.`,
            });
          }
          if (existing.httpOnly === httpOnly) {
            return {
              ...existingRoute,
              routeString: label,
              alreadyExisted: true,
            };
          }
        }

        const sameHostRoutes = await db.serviceRoute.findMany({
          where: { domainId: domain.id, subdomain },
          select: { id: true, httpOnly: true },
        });
        if (sameHostRoutes.some((other) => other.httpOnly !== httpOnly)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "All routes on the same host must use the same HTTP-only setting.",
          });
        }
      }

      let route;
      try {
        route = await db.serviceRoute.create({
          data: {
            serviceId: input.serviceId,
            domainId: domain?.id,
            pathPrefix,
            subdomain,
            httpOnly,
          },
          include: { domain: true },
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Route already exists for this host/path.",
          });
        }
        throw err;
      }

      // Await Caddy reload so the new hostname is served before we probe TLS.
      try {
        await reloadCaddy();
      } catch (err) {
        console.error("[services] Caddy reload failed after addRoute:", err);
      }

      // Probe TLS for the new route's hostname and persist the result.
      if (route.domain && !route.httpOnly) {
        try {
          route.tlsStatus = await probeRouteTls(route);
        } catch (err) {
          console.error("[services] TLS probe failed after addRoute:", err);
        }
      }

      return {
        ...route,
        routeString: formatRouteString(route),
        alreadyExisted: false,
      };
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
        const resolved = await resolveRouteInput(input.host);
        route = await db.serviceRoute.findFirst({
          where: {
            serviceId: input.serviceId,
            domainId: resolved.domain.id,
            subdomain: resolved.subdomain,
            pathPrefix: resolved.pathPrefix,
          },
        });
        if (!route)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `This service has no route ${resolved.route}. See its routes with siteyctl service get.`,
          });
      }
      if (!route)
        throw new TRPCError({ code: "NOT_FOUND", message: "Route not found" });
      if (route.protected)
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "This route cannot be removed",
        });
      await db.serviceRoute.delete({ where: { id: route.id } });
      reloadCaddy().catch((err) =>
        console.error("[services] Caddy reload failed after removeRoute:", err),
      );
      return { ok: true };
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
