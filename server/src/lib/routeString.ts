/**
 * Route strings: `[http://]host[/pathPrefix]`.
 *
 * siteyctl and the export describe a route as one URL-like string instead of a
 * (Domain row, subdomain, pathPrefix, httpOnly) tuple. The server works out
 * which Domain row a host belongs to:
 *
 *   1. A Domain row for exactly `host`.
 *   2. Otherwise the wildcard row `*.<rest>`, where host is `<label>.<rest>`
 *      and `<label>` is a single DNS label (it becomes the route's subdomain).
 *   3. Otherwise nothing: route strings never create domains implicitly.
 *
 * `http://` marks an HTTP-only route; no scheme (or `https://`) means HTTPS.
 */

const DNS_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOSTNAME_REGEX = new RegExp(`^${DNS_LABEL}(?:\\.${DNS_LABEL})*$`);
const PATH_SEGMENT_REGEX = /^[A-Za-z0-9._~-]+$/;

export class RouteStringError extends Error {}

export type ParsedRoute = {
  host: string;
  pathPrefix: string;
  httpOnly: boolean;
};

export function parseRouteString(input: string): ParsedRoute {
  let rest = input.trim();
  let httpOnly = false;

  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(rest);
  if (scheme) {
    const name = scheme[1].toLowerCase();
    if (name !== "http" && name !== "https") {
      throw new RouteStringError(
        `Unsupported scheme "${name}://" in route "${input}". Use host[/path] or http://host[/path].`,
      );
    }
    httpOnly = name === "http";
    rest = rest.slice(scheme[0].length);
  }

  if (/[?#]/.test(rest)) {
    throw new RouteStringError(
      `Route "${input}" can't contain a query or fragment.`,
    );
  }

  const slash = rest.indexOf("/");
  const hostPart = slash === -1 ? rest : rest.slice(0, slash);
  const pathPart = slash === -1 ? "" : rest.slice(slash);

  const host = hostPart.toLowerCase().replace(/\.$/, "");
  if (hostPart.includes(":")) {
    throw new RouteStringError(
      `Route "${input}" can't include a port. Sitey serves routes on 80/443.`,
    );
  }
  if (!HOSTNAME_REGEX.test(host)) {
    throw new RouteStringError(
      `"${hostPart}" in route "${input}" is not a valid hostname.`,
    );
  }

  const segments = pathPart.split("/").filter(Boolean);
  for (const segment of segments) {
    if (
      !PATH_SEGMENT_REGEX.test(segment) ||
      segment === "." ||
      segment === ".."
    ) {
      throw new RouteStringError(
        `Path segment "${segment}" in route "${input}" is not allowed. Use letters, digits, '.', '_', '~' or '-'.`,
      );
    }
  }
  const pathPrefix = segments.length ? `/${segments.join("/")}` : "";

  return { host, pathPrefix, httpOnly };
}

export type DomainRow = { id: number; hostname: string };

export function resolveRouteHost<D extends DomainRow>(
  host: string,
  domains: D[],
): { domain: D; subdomain: string } | null {
  const exact = domains.find(
    (d) => !d.hostname.startsWith("*.") && d.hostname === host,
  );
  if (exact) return { domain: exact, subdomain: "" };

  const dot = host.indexOf(".");
  if (dot === -1) return null;
  const label = host.slice(0, dot);
  const wildcard = domains.find(
    (d) => d.hostname === `*.${host.slice(dot + 1)}`,
  );
  if (wildcard) return { domain: wildcard, subdomain: label };

  return null;
}

/** The route string for a stored route, or null for the domainless catch-all. */
export function formatRouteString(route: {
  domain: { hostname: string } | null;
  subdomain: string;
  pathPrefix: string;
  httpOnly: boolean;
}): string | null {
  if (!route.domain) return null;
  const { hostname } = route.domain;
  const host = hostname.startsWith("*.")
    ? route.subdomain
      ? `${route.subdomain}.${hostname.slice(2)}`
      : hostname
    : hostname;
  return `${route.httpOnly ? "http://" : ""}${host}${route.pathPrefix}`;
}
