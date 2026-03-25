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

  create: settledProcedure
    .input(
      z.object({
        name: z
          .string()
          .min(1)
          .max(40)
          .regex(/^[a-z0-9-]+$/, "Lowercase alphanumeric and hyphens only"),
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

      // Find or create the Repo
      const repo = await findOrCreateRepo(repoOwner, repoName, githubMode);

      // Update repo's githubMode if it changed
      await db.repo.update({
        where: { id: repo.id },
        data: { githubMode },
      });

      const service = await db.service.create({
        data: {
          ...serviceData,
          repoId: repo.id,
        },
      });

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

      return service;
    }),

  update: settledProcedure
    .input(
      z.object({
        id: z.number().int(),
        name: z
          .string()
          .min(1)
          .max(40)
          .regex(/^[a-z0-9-]+$/, "Lowercase alphanumeric and hyphens only")
          .optional(),
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
      return db.service.update({
        where: { id },
        data: rest,
      });
    }),

  delete: settledProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ input }) => {
      const service = await db.service.findUnique({ where: { id: input.id } });
      if (!service)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Service not found",
        });
      if (service.protected)
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "This service cannot be deleted",
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

      return { ok: true };
    }),

  // ── Routes ─────────────────────────────────────────────────────────────────

  addRoute: settledProcedure
    .input(
      z.object({
        serviceId: z.number().int(),
        domainId: z.number().int().optional(),
        pathPrefix: z.string().default(""),
        subdomain: z.string().default(""),
        httpOnly: z.boolean().default(false),
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

      let subdomain = input.subdomain.trim().toLowerCase();
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
            message: "Subdomain can only be set when using a wildcard domain.",
          });
        }
        subdomain = "";
      }

      if (domain && isLoopbackHost(domain.hostname) && !input.httpOnly) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "localhost routes must be created as HTTP-only.",
        });
      }

      if (input.domainId) {
        const sameHostRoutes = await db.serviceRoute.findMany({
          where: { domainId: input.domainId, subdomain },
          select: { id: true, httpOnly: true },
        });
        if (
          sameHostRoutes.some(
            (existing) => existing.httpOnly !== input.httpOnly,
          )
        ) {
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
            domainId: input.domainId,
            pathPrefix: input.pathPrefix,
            subdomain,
            httpOnly: input.httpOnly,
          },
          include: { domain: true },
        });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "P2002") {
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

      return route;
    }),

  removeRoute: settledProcedure
    .input(z.object({ routeId: z.string() }))
    .mutation(async ({ input }) => {
      const route = await db.serviceRoute.findUnique({
        where: { id: input.routeId },
      });
      if (!route)
        throw new TRPCError({ code: "NOT_FOUND", message: "Route not found" });
      if (route.protected)
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "This route cannot be removed",
        });
      await db.serviceRoute.delete({ where: { id: input.routeId } });
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
      const webhookUrl = `${baseUrl}/hook/${endpoint.publicId}`;

      return {
        webhookUrl,
        webhookSecret: endpoint?.secret ?? null,
        githubMode: service.repo.githubMode,
        domains: webhookDomains,
      };
    }),
});
