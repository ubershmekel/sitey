/**
 * Docker orchestration service.
 * Communicates with the Docker daemon via the mounted socket at /var/run/docker.sock.
 *
 * Key operations:
 *  - createNetworkIfMissing     — ensure sitey-public network exists
 *  - buildImage                 — docker build for a project
 *  - runOrReplaceContainer      — start container with optional Caddy labels, kill old one
 *  - stopContainer              — stop + remove a running container
 *  - pruneProjectImages         — remove old images for a project
 */

import Docker from "dockerode";
import type { Project } from "@prisma/client";
import { db } from "../lib/db.js";

export const docker = new Docker({ socketPath: "/var/run/docker.sock" });

export const SITEY_NETWORK = "sitey-public";

// ── Network ───────────────────────────────────────────────────────────────────

export async function createNetworkIfMissing(): Promise<void> {
  const networks = await docker.listNetworks({
    filters: { name: [SITEY_NETWORK] },
  });
  if (networks.length === 0) {
    await docker.createNetwork({
      Name: SITEY_NETWORK,
      Driver: "bridge",
      Labels: { "sitey.managed": "true" },
    });
    console.log(`[docker] Created network: ${SITEY_NETWORK}`);
  }
}

// ── Image build ───────────────────────────────────────────────────────────────

export async function buildImage(opts: {
  projectId: string;
  repoPath: string;
  tag: string;
  onLog: (line: string) => void;
}): Promise<void> {
  const { projectId, repoPath, tag, onLog } = opts;

  onLog(`[docker] Building image ${tag} from ${repoPath}`);

  const stream = await docker.buildImage(
    { context: repoPath, src: ["."] },
    { t: tag, labels: { "sitey.project": projectId } },
  );

  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(
      stream,
      (err: Error | null) => (err ? reject(err) : resolve()),
      (event: { stream?: string; error?: string }) => {
        const line = event.stream ?? event.error ?? "";
        if (line.trim()) onLog(line.trimEnd());
        if (event.error) reject(new Error(event.error));
      },
    );
  });
}

// ── Caddy labels ──────────────────────────────────────────────────────────────
// caddy-docker-proxy reads these labels and generates Caddy site blocks.
// Multiple routes produce numbered label sets: caddy.0, caddy.1, …
//
// Route combinations:
//   domain + subdomain                → app.example.com
//   domain + subdomain + pathPrefix   → app.example.com/blog/*
//   no domain + pathPrefix            → :80/blog/* (server IP, any host)
//   no domain + no prefix             → catch-all (reserved for sitey itself)

type Route = {
  domain?: { hostname: string } | null;
  pathPrefix: string;
};

export function buildCaddyLabels(
  project: Project,
  routes: Route[],
): Record<string, string> {
  const labels: Record<string, string> = {
    "sitey.managed": "true",
    "sitey.project": project.id,
  };

  // Routes with no domain AND no pathPrefix are the root catch-all —
  // those belong to sitey itself and don't get container labels.
  const routable = routes.filter((r) => r.domain || r.pathPrefix);

  routable.forEach((route, i) => {
    const prefix = routable.length === 1 ? "caddy" : `caddy.${i}`;

    const host = route.domain ? route.domain.hostname : ":80";

    if (route.pathPrefix) {
      labels[prefix] = host;
      labels[`${prefix}.handle_path`] = `${route.pathPrefix}/*`;
      labels[`${prefix}.handle_path.reverse_proxy`] =
        `{{upstreams ${project.containerPort}}}`;
    } else {
      labels[prefix] = host;
      labels[`${prefix}.reverse_proxy`] =
        `{{upstreams ${project.containerPort}}}`;
    }
  });

  return labels;
}

// ── Host port allocation ──────────────────────────────────────────────────────
// Used for projects with no domain — assigns a stable host port so the app is
// reachable at http://<server-ip>:<hostPort>.

export async function allocateHostPort(): Promise<number> {
  const highest = await db.project.findFirst({
    where: { hostPort: { not: null } },
    orderBy: { hostPort: "desc" },
    select: { hostPort: true },
  });
  return (highest?.hostPort ?? 19999) + 1;
}

// ── Run / replace container ───────────────────────────────────────────────────

export async function runOrReplaceContainer(opts: {
  project: Project;
  routes: Route[];
  imageTag: string;
  containerName: string;
  envVars: Record<string, string>;
  hostPort: number | null;
  onLog: (line: string) => void;
}): Promise<string> {
  const { project, routes, imageTag, containerName, envVars, hostPort, onLog } = opts;

  await stopAndRemoveContainer(containerName, onLog);

  const labels = buildCaddyLabels(project, routes);
  const env = Object.entries(envVars).map(([k, v]) => `${k}=${v}`);

  onLog(`[docker] Creating container ${containerName}`);

  const portBindings = hostPort
    ? {
        [`${project.containerPort}/tcp`]: [
          { HostIp: "0.0.0.0", HostPort: String(hostPort) },
        ],
      }
    : {};

  const container = await docker.createContainer({
    Image: imageTag,
    name: containerName,
    Env: env,
    Labels: labels,
    ExposedPorts: { [`${project.containerPort}/tcp`]: {} },
    HostConfig: {
      NetworkMode: SITEY_NETWORK,
      RestartPolicy: { Name: "unless-stopped" },
      PortBindings: portBindings,
    },
  });

  await container.start();
  onLog(
    `[docker] Container ${containerName} started (id: ${container.id.slice(0, 12)})`,
  );
  return container.id;
}

// ── Stop / remove ─────────────────────────────────────────────────────────────

export async function stopAndRemoveContainer(
  name: string,
  onLog: (l: string) => void,
): Promise<void> {
  try {
    const existing = docker.getContainer(name);
    const info = await existing.inspect();
    if (info.State.Running) {
      onLog(`[docker] Stopping old container ${name}`);
      await existing.stop({ t: 10 });
    }
    onLog(`[docker] Removing old container ${name}`);
    await existing.remove({ force: true });
  } catch (err: unknown) {
    const e = err as { statusCode?: number };
    if (e.statusCode !== 404) {
      onLog(
        `[docker] Warning: could not remove ${name}: ${(err as Error).message}`,
      );
    }
  }
}

// ── Prune old images ──────────────────────────────────────────────────────────

export async function pruneProjectImages(
  projectId: string,
  keepTag: string,
): Promise<void> {
  const images = await docker.listImages({
    filters: { label: [`sitey.project=${projectId}`] },
  });
  for (const img of images) {
    if (!img.RepoTags?.includes(keepTag)) {
      try {
        await docker.getImage(img.Id).remove({ force: false });
      } catch {
        // ignore — image may be in use
      }
    }
  }
}

// ── Dockerfile generators ─────────────────────────────────────────────────────

/** Server Dockerfile with optional build step and custom run command */
export function generateServerDockerfile(
  buildCommand: string,
  serverRunCommand: string,
  containerPort = 3000,
): string {
  const buildStep = buildCommand.trim() ? `RUN ${buildCommand.trim()}\n` : ''
  const cmd = serverRunCommand.trim()
  return `FROM node:25-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:25-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
${buildStep}
FROM node:25-alpine AS runner
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app .
ENV NODE_ENV=production
ENV PORT=${containerPort}
EXPOSE ${containerPort}
CMD ["sh", "-c", "${cmd}"]
`
}

export function generateDefaultDockerfile(containerPort = 3000): string {
  return `FROM node:25-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:25-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build --if-present

FROM node:25-alpine
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app .
ENV NODE_ENV=production
ENV PORT=${containerPort}
EXPOSE ${containerPort}
CMD ["node", "server.js"]
`;
}

export function generateStaticDockerfile(
  buildCommand: string,
  outputDir: string,
  containerPort = 3000,
): string {
  const cmd = buildCommand.trim() || "npm run build";
  return `FROM node:25-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN ${cmd}

FROM caddy:alpine
COPY --from=builder /app/${outputDir} /srv
RUN printf ':${containerPort} {\\n    root * /srv\\n    encode gzip\\n    try_files {path} /index.html\\n    file_server\\n}\\n' > /etc/caddy/Caddyfile
EXPOSE ${containerPort}
`;
}
