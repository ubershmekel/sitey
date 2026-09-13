/**
 * Export Sitey's config-shaped tables (domains, repos, services, routes) as YAML.
 *
 * Preview of infra-as-code: nothing reads this format back yet. Field names
 * mirror schema.prisma so the file and the UI share one vocabulary. Runtime
 * state (status, containerId, tlsStatus, deployments), auth (users, tokens) and
 * secrets (env var values, hook secrets, GitHub App creds) are left out.
 */

import { stringify } from "yaml";
import { db } from "../lib/db.ts";

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
  protected: boolean;
};

type ServiceRow = {
  id: number;
  name: string;
  repoId: number;
  branch: string;
  deployMode: string;
  buildCommand: string;
  outputDir: string;
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
  domains: DomainRow[];
  repos: RepoRow[];
  services: ServiceRow[];
};

// Schema defaults. Fields equal to these (or undefined) are omitted to keep the
// file readable.
const SERVICE_DEFAULTS = {
  branch: "main",
  buildCommand: "",
  outputDir: "",
  buildImage: "",
  buildMode: "auto",
  dockerfilePath: "",
  serverRunCommand: "",
  containerPort: 3000,
  protected: false,
  active: true,
};

const ROUTE_DEFAULTS = {
  subdomain: "",
  pathPrefix: "",
  httpOnly: false,
  protected: false,
};

function withoutDefaults(
  obj: Record<string, unknown>,
  defaults: Record<string, unknown> = {},
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(obj).filter(
      ([k, v]) => v !== undefined && !(k in defaults && defaults[k] === v),
    ),
  );
}

/**
 * Env var names only — values are secrets and stay out of the export. Lines
 * without "=" are skipped (as parseEnvString does): they may be continuation
 * lines of a multi-line secret, not names.
 */
export function envVarNames(envVars: string): string[] {
  return envVars
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) =>
      line
        .slice(0, line.indexOf("="))
        .replace(/^export\s+/, "")
        .trim(),
    )
    .filter(Boolean);
}

/**
 * Repos are referenced from services by name. Names aren't unique in the schema
 * (and may be empty), so fall back to owner/name, then suffix the id.
 */
function repoKeys(repos: RepoRow[]): Map<number, string> {
  const base = (r: RepoRow) =>
    r.name ||
    (r.repoOwner && r.repoName ? `${r.repoOwner}/${r.repoName}` : "") ||
    `repo-${r.id}`;
  const counts = new Map<string, number>();
  for (const r of repos) counts.set(base(r), (counts.get(base(r)) ?? 0) + 1);
  // Unique names claim themselves first so a suffixed duplicate can't steal
  // one (e.g. two "site" repos vs. a repo actually named "site-3").
  const taken = new Set([...counts].filter(([, n]) => n === 1).map(([k]) => k));
  const keys = new Map<number, string>();
  for (const r of [...repos].sort((a, b) => a.id - b.id)) {
    if (counts.get(base(r)) === 1) {
      keys.set(r.id, base(r));
      continue;
    }
    let key = `${base(r)}-${r.id}`;
    while (taken.has(key)) key += `-${r.id}`;
    taken.add(key);
    keys.set(r.id, key);
  }
  return keys;
}

export function buildExportDoc(input: ExportInput) {
  const domainById = new Map(input.domains.map((d) => [d.id, d.hostname]));
  const repoKey = repoKeys(input.repos);

  const domains = [...input.domains]
    .sort((a, b) => a.hostname.localeCompare(b.hostname))
    .map((d) =>
      withoutDefaults({
        hostname: d.hostname,
        letsEncryptEmail: d.letsEncryptEmail,
        // Only meaningful for wildcard domains.
        siteySubdomainsEnabled: d.hostname.startsWith("*.")
          ? d.siteySubdomainsEnabled
          : undefined,
      }),
    );

  const repos = [...input.repos]
    .sort((a, b) => repoKey.get(a.id)!.localeCompare(repoKey.get(b.id)!))
    .map((r) =>
      withoutDefaults(
        {
          name: repoKey.get(r.id),
          repoOwner: r.repoOwner,
          repoName: r.repoName,
          githubMode: r.githubMode,
        },
        { repoOwner: "", repoName: "" },
      ),
    );

  const services = [...input.services]
    .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id)
    .map((s) => {
      const routes = s.routes
        .map((r) =>
          withoutDefaults(
            {
              // No domain = the catch-all route (the built-in sitey panel).
              domain:
                r.domainId == null ? undefined : domainById.get(r.domainId),
              subdomain: r.subdomain,
              pathPrefix: r.pathPrefix,
              httpOnly: r.httpOnly,
              protected: r.protected,
            },
            ROUTE_DEFAULTS,
          ),
        )
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      const env = envVarNames(s.envVars);

      return withoutDefaults(
        {
          name: s.name,
          repo: repoKey.get(s.repoId),
          branch: s.branch,
          deployMode: s.deployMode,
          buildCommand: s.buildCommand,
          outputDir: s.outputDir,
          buildImage: s.buildImage,
          buildMode: s.buildMode,
          dockerfilePath: s.dockerfilePath,
          serverRunCommand: s.serverRunCommand,
          containerPort:
            s.deployMode === "static" ? undefined : s.containerPort,
          env: env.length ? env : undefined,
          protected: s.protected,
          active: s.active,
          routes: routes.length ? routes : undefined,
        },
        SERVICE_DEFAULTS,
      );
    });

  return { domains, repos, services };
}

export function renderExportYaml(input: ExportInput, now = new Date()): string {
  const header = [
    `# Sitey config export (${now.toISOString()})`,
    "# Preview only: nothing reads this file back yet.",
    "# Omitted: runtime state, deployments, users/tokens, and secrets",
    "# (env var values, webhook secrets, GitHub App credentials).",
    "",
  ].join("\n");
  return header + stringify(buildExportDoc(input), { lineWidth: 0 });
}

export async function loadExportInput(): Promise<ExportInput> {
  const [domains, repos, services] = await Promise.all([
    db.domain.findMany(),
    db.repo.findMany(),
    db.service.findMany({ include: { routes: true } }),
  ]);
  return { domains, repos, services };
}
