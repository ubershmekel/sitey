/**
 * Docker orchestration service.
 * Communicates with the Docker daemon via the mounted socket at /var/run/docker.sock.
 *
 * Key operations:
 *  - createNetworkIfMissing     — ensure sitey-public network exists
 *  - buildImage                 — docker build for a project
 *  - runOrReplaceContainer      — start container, kill old one
 *  - stopContainer              — stop + remove a running container
 *  - pruneProjectImages         — remove old images for a project
 *
 * Routing / TLS is managed separately via the Caddy Admin API (caddy.ts).
 * Containers no longer carry caddy-docker-proxy labels.
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
  projectId: number;
  contextPath: string;
  tag: string;
  dockerfile: string;
  onLog: (line: string) => void;
}): Promise<void> {
  const { projectId, contextPath, tag, dockerfile, onLog } = opts;

  onLog(
    `[docker] Building image ${tag} from ${contextPath} (dockerfile: ${dockerfile})`,
  );

  const stream = await docker.buildImage(
    { context: contextPath, src: ["."] },
    { t: tag, dockerfile, labels: { "sitey.project": String(projectId) } },
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
  imageTag: string;
  containerName: string;
  envVars: Record<string, string>;
  hostPort: number | null;
  onLog: (line: string) => void;
}): Promise<string> {
  const { project, imageTag, containerName, envVars, hostPort, onLog } = opts;

  await stopAndRemoveContainer(containerName, onLog);

  const labels: Record<string, string> = {
    "sitey.managed": "true",
    "sitey.project": String(project.id),
  };
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
  projectId: number,
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
  sourceRoot = ".",
): string {
  const buildStep = buildCommand.trim() ? `RUN ${buildCommand.trim()}\n` : "";
  const cmd = serverRunCommand.trim();
  // package.json and package-lock.json
  const packageJsonSource =
    sourceRoot === "." ? "package*.json" : `${sourceRoot}/package*.json`;
  const fullSource = sourceRoot === "." ? "." : `${sourceRoot}/.`;
  return `FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY ${packageJsonSource} ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY ${packageJsonSource} ./
RUN npm ci
COPY ${fullSource} .
${buildStep}
FROM node:22-bookworm-slim AS runner
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app .
ENV NODE_ENV=production
ENV PORT=${containerPort}
EXPOSE ${containerPort}
CMD ["sh", "-c", "${cmd}"]
`;
}

export function generateDefaultDockerfile(
  containerPort = 3000,
  sourceRoot = ".",
): string {
  const packageJsonSource =
    sourceRoot === "." ? "package*.json" : `${sourceRoot}/package*.json`;
  const fullSource = sourceRoot === "." ? "." : `${sourceRoot}/.`;
  return `FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY ${packageJsonSource} ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY ${packageJsonSource} ./
RUN npm ci
COPY ${fullSource} .
RUN npm run build --if-present

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app .
ENV NODE_ENV=production
ENV PORT=${containerPort}
EXPOSE ${containerPort}
CMD ["node", "server.js"]
`;
}
