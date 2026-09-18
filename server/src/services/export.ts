/**
 * Export Sitey's configuration as YAML: an inventory that can be committed to
 * git so config changes show up as diffs (`siteyctl export -o sitey/x.yaml`).
 *
 * Read-only: nothing reads this format back yet. The output is deterministic
 * (no timestamps; sorted domains, services, routes) so exporting twice gives
 * identical bytes. Runtime state (status, containers, TLS), deployments, users,
 * tokens and secret values (env var values, hook secrets, GitHub App creds) are
 * left out. See docs/design/remote-cli.md.
 */

import { Document, isMap, isScalar } from "yaml";
import { db } from "../lib/db.ts";
import { envVarNames } from "../lib/envFile.ts";
import { formatRouteString } from "../lib/routeString.ts";
import { formatServiceRef } from "../lib/serviceRef.ts";
import { resolvePublicSiteUrl } from "./siteUrl.ts";

export const EXPORT_VERSION = 1;

type DomainRow = {
  id: number;
  hostname: string;
  letsEncryptEmail: string;
  siteySubdomainsEnabled: boolean;
};

type RepoRow = {
  id: number;
  name: string;
  repoOwner: string;
  repoName: string;
  githubMode: string;
};

type RouteRow = {
  domainId: number | null;
  subdomain: string;
  pathPrefix: string;
  httpOnly: boolean;
};

type ServiceRow = {
  id: number;
  name: string;
  repoId: number;
  branch: string;
  deployMode: string;
  buildCommand: string;
  outputDir: string;
  staticRoutingMode: string;
  staticCaddyConfig: string;
  buildImage: string;
  buildMode: string;
  dockerfilePath: string;
  serverRunCommand: string;
  containerPort: number;
  envVars: string;
  protected: boolean;
  active: boolean;
  routes: RouteRow[];
};

export type ExportInput = {
  /** The effective Public Sitey URL: where the panel and API live. */
  siteyUrl: string | null;
  domains: DomainRow[];
  repos: RepoRow[];
  services: ServiceRow[];
};

// Plain code-unit comparison: localeCompare can differ between machines.
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Groups hosts by registrable domain: andluck.com, *.andluck.com, x.andluck.com. */
function compareHostnames(a: string, b: string): number {
  const la = a.split(".").reverse();
  const lb = b.split(".").reverse();
  for (let i = 0; i < Math.min(la.length, lb.length); i++) {
    const c = compare(la[i], lb[i]);
    if (c) return c;
  }
  return la.length - lb.length;
}

/** Drops fields that are undefined or equal to their schema default. */
function withoutDefaults(
  obj: Record<string, unknown>,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(obj).filter(
      ([k, v]) => v !== undefined && !(k in defaults && defaults[k] === v),
    ),
  );
}

const SERVICE_DEFAULTS = {
  githubMode: "app",
  active: true,
  branch: "main",
  buildMode: "auto",
  dockerfilePath: "",
  buildImage: "",
  buildCommand: "",
  outputDir: "",
  staticRoutingMode: "spa",
  staticCaddyConfig: "",
  serverRunCommand: "",
  containerPort: 3000,
};

export function buildExportDoc(input: ExportInput) {
  const domainById = new Map(input.domains.map((d) => [d.id, d]));
  const repoById = new Map(input.repos.map((r) => [r.id, r]));

  const domains = [...input.domains]
    .sort((a, b) => compareHostnames(a.hostname, b.hostname))
    .map((d) => {
      const settings = withoutDefaults(
        {
          letsEncryptEmail: d.letsEncryptEmail.trim(),
          // Only meaningful for wildcard domains: serve the panel at sitey.<base>.
          siteySubdomains: d.hostname.startsWith("*.")
            ? d.siteySubdomainsEnabled
            : undefined,
        },
        { letsEncryptEmail: "", siteySubdomains: true },
      );
      return Object.keys(settings).length
        ? { hostname: d.hostname, ...settings }
        : d.hostname;
    });

  const services: Record<string, Record<string, unknown>> = {};
  for (const s of [...input.services].sort((a, b) => a.id - b.id)) {
    // The built-in sitey panel; `siteyUrl` says where it lives.
    if (s.protected) continue;

    const repo = repoById.get(s.repoId);
    const routes = s.routes
      .map((r) =>
        formatRouteString({
          ...r,
          domain:
            r.domainId == null ? null : (domainById.get(r.domainId) ?? null),
        }),
      )
      .filter((r) => r !== null)
      .sort(compare);
    const env = envVarNames(s.envVars).sort(compare);

    services[formatServiceRef(s.id)] = withoutDefaults(
      {
        name: s.name,
        repo:
          repo && repo.repoOwner && repo.repoName
            ? `${repo.repoOwner}/${repo.repoName}`
            : repo?.name,
        githubMode: repo?.githubMode,
        active: s.active,
        branch: s.branch,
        deployMode: s.deployMode,
        buildMode: s.buildMode,
        dockerfilePath: s.dockerfilePath,
        buildImage: s.buildImage,
        buildCommand: s.buildCommand,
        outputDir: s.outputDir,
        // Routing only affects static services.
        staticRoutingMode:
          s.deployMode === "static" ? s.staticRoutingMode : undefined,
        staticCaddyConfig:
          s.deployMode === "static" && s.staticRoutingMode === "caddy"
            ? s.staticCaddyConfig
            : undefined,
        serverRunCommand: s.serverRunCommand,
        containerPort: s.deployMode === "static" ? undefined : s.containerPort,
        env: env.length ? env : undefined,
        routes: routes.length ? routes : undefined,
      },
      SERVICE_DEFAULTS,
    );
  }

  return {
    version: EXPORT_VERSION,
    siteyUrl: input.siteyUrl,
    domains,
    services,
  };
}

const HEADER = [
  "# Sitey config export. Read-only: nothing reads this file back yet.",
  "# Excludes runtime state, deployments, users/tokens, and secret values.",
  "",
].join("\n");

export function renderExportYaml(input: ExportInput): string {
  const doc = new Document(buildExportDoc(input));
  // Blank lines before each top-level section after the header fields, and
  // between services, so a diff reads block by block.
  if (isMap(doc.contents)) {
    for (const pair of doc.contents.items) {
      const key = isScalar(pair.key) ? pair.key.value : null;
      if (key === "domains" || key === "services") {
        (pair.key as { spaceBefore?: boolean }).spaceBefore = true;
      }
      if (key === "services" && isMap(pair.value)) {
        pair.value.items.forEach((service, i) => {
          if (i > 0)
            (service.key as { spaceBefore?: boolean }).spaceBefore = true;
        });
      }
    }
  }
  return HEADER + doc.toString({ lineWidth: 0 });
}

export async function loadExportInput(): Promise<ExportInput> {
  const [domains, repos, services, siteUrl] = await Promise.all([
    db.domain.findMany(),
    db.repo.findMany(),
    db.service.findMany({ include: { routes: true } }),
    resolvePublicSiteUrl(),
  ]);
  return { siteyUrl: siteUrl.effectiveUrl, domains, repos, services };
}
