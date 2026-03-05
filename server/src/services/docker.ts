/**
 * Docker orchestration service.
 * Communicates with the Docker daemon via the mounted socket at /var/run/docker.sock.
 *
 * Key operations:
 *  - createNetworkIfMissing     — ensure sitey-public network exists
 *  - buildImage                 — docker build for a project
 *  - runOrReplaceContainer      — start container with Caddy labels, kill old one
 *  - stopContainer              — stop + remove a running container
 *  - pruneProjectImages         — remove old images for a project
 */

import Docker from "dockerode";
import type { Project } from "@prisma/client";

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
// caddy-docker-proxy reads these two labels and generates a Caddy site block.
// HTTPS + HTTP→HTTPS redirect are automatic via the global ACME config in Caddyfile.

export function buildCaddyLabels(
  project: Project & { domain: { hostname: string } },
): Record<string, string> {
  const host = project.subdomain
    ? `${project.subdomain}.${project.domain.hostname}`
    : project.domain.hostname;

  return {
    caddy: host,
    "caddy.reverse_proxy": `{{upstreams ${project.containerPort}}}`,
    "sitey.managed": "true",
    "sitey.project": project.id,
  };
}

// ── Run / replace container ───────────────────────────────────────────────────

export async function runOrReplaceContainer(opts: {
  project: Project & { domain: { hostname: string } };
  imageTag: string;
  containerName: string;
  envVars: Record<string, string>;
  onLog: (line: string) => void;
}): Promise<string> {
  const { project, imageTag, containerName, envVars, onLog } = opts;

  await stopAndRemoveContainer(containerName, onLog);

  const labels = buildCaddyLabels(project);
  const env = Object.entries(envVars).map(([k, v]) => `${k}=${v}`);

  onLog(`[docker] Creating container ${containerName}`);

  const container = await docker.createContainer({
    Image: imageTag,
    name: containerName,
    Env: env,
    Labels: labels,
    ExposedPorts: { [`${project.containerPort}/tcp`]: {} },
    HostConfig: {
      NetworkMode: SITEY_NETWORK,
      RestartPolicy: { Name: "unless-stopped" },
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

// ── Default Dockerfile generator ─────────────────────────────────────────────

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
