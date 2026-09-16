import { TRPCError } from "@trpc/server";
import type { Prisma } from "../generated/prisma/client.ts";
import { db } from "../lib/db.ts";
import {
  formatRouteString,
  parseRouteString,
  resolveRouteHost,
  RouteStringError,
} from "../lib/routeString.ts";
import { isLoopbackHost, resolvePublicSiteUrl } from "./siteUrl.ts";

type Store = Prisma.TransactionClient;

export function parseRoute(input: string) {
  try {
    return parseRouteString(input);
  } catch (err) {
    if (err instanceof RouteStringError)
      throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
    throw err;
  }
}

export async function resolveRouteInput(route: string, store: Store = db) {
  const parsed = parseRoute(route);
  const domains = await store.domain.findMany({
    select: { id: true, hostname: true },
  });
  const match = resolveRouteHost(parsed.host, domains);
  if (!match)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `No domain covers ${parsed.host}. Add one with siteyctl domain add ${parsed.host}.`,
    });
  return {
    ...parsed,
    ...match,
    route: formatRouteString({ ...parsed, ...match })!,
  };
}

/** Domain IDs are storage details; hostname/path is the public route identity. */
export async function routesForHost(host: string, store: Store = db) {
  const dot = host.indexOf(".");
  return store.serviceRoute.findMany({
    where: {
      OR: [
        { domain: { hostname: host } },
        ...(dot < 0
          ? []
          : [
              {
                domain: { hostname: `*.${host.slice(dot + 1)}` },
                subdomain: host.slice(0, dot),
              },
            ]),
      ],
    },
    include: { domain: true, service: { select: { id: true, name: true } } },
  });
}

export async function assertRouteAllowed(
  host: string,
  pathPrefix: string,
  httpOnly: boolean,
) {
  if (isLoopbackHost(host) && !httpOnly)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `localhost routes are HTTP-only. Use http://${host}${pathPrefix}`,
    });
  const siteUrl = await resolvePublicSiteUrl();
  const managementHost = (
    process.env.SITEY_DOMAIN ||
    (siteUrl.effectiveUrl ? new URL(siteUrl.effectiveUrl).hostname : "")
  ).toLowerCase();
  if (host === managementHost && (!pathPrefix || httpOnly)) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `${host} is reserved for the Sitey management site. Choose another hostname.`,
    });
  }
}

export function assertCompatibleHost(
  routes: Awaited<ReturnType<typeof routesForHost>>,
  httpOnly: boolean,
) {
  if (routes.some((r) => r.httpOnly !== httpOnly))
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "All routes on the same host must use the same HTTP-only setting.",
    });
}

export async function insertResolvedRoute(
  store: Store,
  serviceId: number,
  resolved: Awaited<ReturnType<typeof resolveRouteInput>>,
) {
  const routes = await routesForHost(resolved.host, store);
  const existing = routes.find((r) => r.pathPrefix === resolved.pathPrefix);
  if (existing && existing.serviceId !== serviceId)
    throw new TRPCError({
      code: "CONFLICT",
      message: `${resolved.route} is already routed to service "${existing.service.name}" (service-${existing.serviceId}). Remove it there first.`,
    });
  assertCompatibleHost(routes, resolved.httpOnly);
  if (existing) {
    const { service: _owner, ...route } = existing;
    return { ...route, alreadyExisted: true };
  }
  const route = await store.serviceRoute.create({
    data: {
      serviceId,
      domainId: resolved.domain.id,
      subdomain: resolved.subdomain,
      pathPrefix: resolved.pathPrefix,
      httpOnly: resolved.httpOnly,
    },
    include: { domain: true },
  });
  return { ...route, alreadyExisted: false };
}
