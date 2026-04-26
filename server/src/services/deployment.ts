/**
 * Deployment orchestrator.
 * Wires together: git clone/pull → docker build → docker run → DB status updates.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Deployment, Service, Repo } from "../generated/prisma/client.ts";
import { PrismaClient } from "../generated/prisma/client.ts";
import { db } from "../lib/db.ts";
import { deployQueue } from "../lib/queue.ts";
import {
  cloneOrPull,
  isTrackedFile,
  serviceRootPath,
  serviceRepoPath,
  serviceDockerfilePath,
  deploymentLogPath,
  serviceLogsDir,
} from "./git.ts";
import {
  docker,
  buildImage,
  runOrReplaceContainer,
  stopAndRemoveContainer,
  createNetworkIfMissing,
  generateDockerfile,
  pruneServiceImages,
  allocateHostPort,
  runBuildContainer,
} from "./docker.ts";
import { reloadCaddy } from "./caddy.ts";
import { getInstallationToken } from "./github.ts";
import { nanoid } from "nanoid";

type RouteWithDomain = {
  domain: { hostname: string } | null;
  pathPrefix: string;
};
type ServiceWithRoutes = Service & { repo: Repo; routes: RouteWithDomain[] };
type OnLog = (line: string) => void;
type DockerBuildSource = { contextPath: string; dockerfilePath: string };
type LogStream = { write(s: string): void; end(): void };

// ── Dependency injection ──────────────────────────────────────────────────────

export type DeployDeps = {
  db: PrismaClient;
  cloneOrPull: typeof cloneOrPull;
  getInstallationToken: typeof getInstallationToken;
  buildImage: typeof buildImage;
  runOrReplaceContainer: typeof runOrReplaceContainer;
  stopAndRemoveContainer: typeof stopAndRemoveContainer;
  createNetworkIfMissing: () => Promise<void>;
  pruneServiceImages: typeof pruneServiceImages;
  allocateHostPort: () => Promise<number>;
  inspectContainer: (
    id: string,
  ) => Promise<{ State: { Running: boolean; Status: string } }>;
  reloadCaddy: () => Promise<void>;
  isTrackedFile: typeof isTrackedFile;
  runBuildContainer: typeof runBuildContainer;
  /** Runs a shell build command in-process. Extracted so tests can skip the real spawn. */
  spawnBuild: (
    cmd: string,
    cwd: string,
    env: Record<string, string>,
    onLog: OnLog,
  ) => Promise<void>;
  /** Delay between container start and crash check. Extracted so tests run instantly. */
  sleep: (ms: number) => Promise<void>;
  createWriteStream: (p: string, opts: { flags: string }) => LogStream;
  mkdirSync: (p: string, opts?: { recursive?: boolean }) => void;
  writeFileSync: (p: string, data: string) => void;
  existsSync: (p: string) => boolean;
};

function defaultSpawnBuild(
  cmd: string,
  cwd: string,
  env: Record<string, string>,
  onLog: OnLog,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("sh", ["-c", cmd], {
      cwd,
      env: { ...process.env, ...env },
    });
    proc.stdout.on("data", (d: Buffer) => onLog(d.toString().trimEnd()));
    proc.stderr.on("data", (d: Buffer) => onLog(d.toString().trimEnd()));
    proc.on("close", (code: number | null) =>
      code === 0
        ? resolve()
        : reject(new Error(`Build exited with code ${code}`)),
    );
    proc.on("error", reject);
  });
}

export const defaultDeps: DeployDeps = {
  db,
  cloneOrPull,
  getInstallationToken,
  buildImage,
  runOrReplaceContainer,
  stopAndRemoveContainer,
  createNetworkIfMissing,
  pruneServiceImages,
  allocateHostPort,
  inspectContainer: (id) => docker.getContainer(id).inspect(),
  reloadCaddy,
  isTrackedFile,
  runBuildContainer,
  spawnBuild: defaultSpawnBuild,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  createWriteStream: (p, opts) => fs.createWriteStream(p, opts),
  mkdirSync: (p, opts) => fs.mkdirSync(p, opts),
  writeFileSync: (p, data) => fs.writeFileSync(p, data),
  existsSync: (p) => fs.existsSync(p),
};

// ── Pure helpers ──────────────────────────────────────────────────────────────

function containerName(service: Service): string {
  return `sitey-service-${service.id}`;
}

function imageTag(service: Service, sha: string): string {
  return `sitey/${service.id}:${sha.slice(0, 12)}`;
}

/** Parse the rollback count from a raw SystemConfig value. Exported for testing. */
export function parseRollbackCount(value: string | undefined): number {
  return Math.max(0, parseInt(value ?? "1", 10) || 0);
}

/**
 * Build the final list of image tags to keep.
 * currentTag is always kept; previousTags is the pre-fetched list of rollback
 * tags (already limited to N by the DB query). Duplicates are removed.
 * Exported for testing.
 */
export function buildKeepTags(
  currentTag: string,
  previousTags: string[],
  n: number,
): string[] {
  if (n === 0) return [currentTag];
  return [currentTag, ...previousTags.filter((t) => t !== currentTag)];
}

function buildManagedDockerfile(service: Service): string {
  return generateDockerfile(
    service.buildCommand,
    service.serverRunCommand,
    service.containerPort,
    "repo",
    service.buildImage || undefined,
  );
}

// ── .env parser ───────────────────────────────────────────────────────────────

export function parseEnvString(raw: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed
      .slice(0, eqIdx)
      .replace(/^export\s+/, "")
      .trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key) vars[key] = val;
  }
  return vars;
}

// ── I/O helpers (receive deps) ────────────────────────────────────────────────

async function getKeepTags(
  service: Service,
  currentTag: string,
  deps: DeployDeps,
): Promise<string[]> {
  const cfg = await deps.db.systemConfig.findUnique({
    where: { key: "cleanup_rollback_count" },
  });
  const n = parseRollbackCount(cfg?.value);
  if (n === 0) return [currentTag];

  const previous = await deps.db.deployment.findMany({
    where: {
      serviceId: service.id,
      status: "success",
      commitSha: { not: null },
    },
    orderBy: { finishedAt: "desc" },
    take: n,
    select: { commitSha: true },
  });

  return buildKeepTags(
    currentTag,
    previous.map((d) => imageTag(service, d.commitSha!)),
    n,
  );
}

function ensureManagedDockerfile(
  service: Service,
  managedDockerfilePath: string,
  onLog: OnLog,
  deps: DeployDeps,
): void {
  deps.mkdirSync(path.dirname(managedDockerfilePath), { recursive: true });
  deps.writeFileSync(managedDockerfilePath, buildManagedDockerfile(service));
  onLog(`[deploy] Wrote managed Dockerfile: ${managedDockerfilePath}`);
}

async function resolveDockerBuildSource(
  service: Service,
  onLog: OnLog,
  deps: DeployDeps,
): Promise<DockerBuildSource> {
  const svcRoot = serviceRootPath(service.id);
  const repoPath = serviceRepoPath(service.id);
  const managedDockerfilePath = serviceDockerfilePath(service.id);
  const dockerfileRelPath = service.dockerfilePath || "Dockerfile";
  const repoDockerfilePath = path.join(repoPath, dockerfileRelPath);
  const repoDockerfileTracked =
    deps.existsSync(repoDockerfilePath) &&
    (await deps.isTrackedFile(repoPath, dockerfileRelPath));

  if (service.buildMode === "dockerfile") {
    if (repoDockerfileTracked) {
      onLog(`[deploy] Using tracked Dockerfile: ${dockerfileRelPath}`);
      return { contextPath: repoPath, dockerfilePath: repoDockerfilePath };
    }
    throw new Error(
      `Build mode is dockerfile, but repository has no tracked Dockerfile at: ${dockerfileRelPath}`,
    );
  }

  if (repoDockerfileTracked) {
    onLog(`[deploy] Using tracked Dockerfile: ${dockerfileRelPath}`);
    return { contextPath: repoPath, dockerfilePath: repoDockerfilePath };
  }

  ensureManagedDockerfile(service, managedDockerfilePath, onLog, deps);
  return { contextPath: svcRoot, dockerfilePath: managedDockerfilePath };
}

// ── Failure handler ───────────────────────────────────────────────────────────

async function handleFailure(
  service: ServiceWithRoutes,
  deployment: Deployment,
  onLog: OnLog,
  deps: DeployDeps,
  reason: string,
): Promise<void> {
  const logPath = deploymentLogPath(service.id, deployment.id);
  onLog(`[deploy] FAILED: ${reason}`);
  await deps.db.deployment.update({
    where: { id: deployment.id },
    data: { status: "failed", finishedAt: new Date(), logPath },
  });
  await deps.db.service.update({
    where: { id: service.id },
    data: { status: "failed", containerId: null, containerName: null },
  });
  try {
    await deps.reloadCaddy();
    onLog("[deploy] Caddy config reloaded after failure");
  } catch (err) {
    onLog(
      `[deploy] Warning: Caddy reload failed after failure: ${(err as Error).message}`,
    );
  }
}

// ── Deploy modes ──────────────────────────────────────────────────────────────

async function deployStatic(
  service: ServiceWithRoutes,
  onLog: OnLog,
  deps: DeployDeps,
): Promise<void> {
  const repoPath = serviceRepoPath(service.id);
  const buildCmd = service.buildCommand.trim() || 'echo "No build step"';
  onLog(`[deploy] Running build: ${buildCmd}`);
  const buildEnv = parseEnvString(service.envVars || "");

  if (service.buildImage) {
    await deps.runBuildContainer({
      serviceId: service.id,
      buildImage: service.buildImage,
      buildCommand: buildCmd,
      envVars: buildEnv,
      onLog,
    });
  } else {
    await deps.spawnBuild(buildCmd, repoPath, buildEnv, onLog);
  }

  if (service.outputDir) {
    const outputPath = path.join(repoPath, service.outputDir);
    if (!deps.existsSync(outputPath)) {
      throw new Error(
        `Build finished but output directory "${service.outputDir}" was not found. Check your build command and output directory setting.`,
      );
    }
  }

  onLog(
    `[deploy] Static deployment successful! Serving from ${repoPath}/${service.outputDir}`,
  );
}

type ServerDeployResult = {
  containerId: string;
  cName: string;
  hostPort: number | null;
};

async function deployServer(
  service: ServiceWithRoutes,
  sha: string,
  onLog: OnLog,
  deps: DeployDeps,
): Promise<ServerDeployResult> {
  // 1. Resolve Dockerfile strategy
  const dockerBuild = await resolveDockerBuildSource(service, onLog, deps);
  const dockerfile = path
    .relative(dockerBuild.contextPath, dockerBuild.dockerfilePath)
    .split(path.sep)
    .join("/");

  // 2. Build image
  const tag = imageTag(service, sha);
  await deps.buildImage({
    serviceId: service.id,
    contextPath: dockerBuild.contextPath,
    tag,
    dockerfile,
    onLog,
  });

  // 3. Resolve host port fallback (used when the service has no routable routes)
  const hasRoutableRoutes = service.routes.some(
    (r: RouteWithDomain) => r.domain || r.pathPrefix,
  );
  let hostPort = service.hostPort;
  if (!hasRoutableRoutes && hostPort === null) {
    hostPort = await deps.allocateHostPort();
    await deps.db.service.update({
      where: { id: service.id },
      data: { hostPort },
    });
    onLog(
      `[deploy] No routes configured — assigned fallback host port ${hostPort}`,
    );
  }

  // 4. Run container (clean up legacy names first)
  const envVars = parseEnvString(service.envVars || "");
  envVars["PORT"] = String(service.containerPort);
  envVars["DATA_DIR"] = "/data";

  const cName = containerName(service);
  for (const legacy of [`sitey-project-${service.id}`, `sitey-${service.id}`]) {
    if (legacy !== cName) await deps.stopAndRemoveContainer(legacy, onLog);
  }

  const containerId = await deps.runOrReplaceContainer({
    service,
    imageTag: tag,
    containerName: cName,
    envVars,
    hostPort,
    onLog,
  });

  // 5. Give the app a brief window to crash fast, then verify it's still running
  await deps.sleep(3000);
  const inspected = await deps.inspectContainer(containerId);
  if (!inspected.State.Running) {
    throw new Error(
      `Container exited right after start (state: ${inspected.State.Status}). Check container logs.`,
    );
  }

  // 6. Prune old images for this service
  const keepTags = await getKeepTags(service, tag, deps);
  await deps.pruneServiceImages(service.id, keepTags, onLog);

  onLog(
    `[deploy] Deployment successful! Container: ${cName} (${containerId.slice(0, 12)})`,
  );
  if (hostPort && !hasRoutableRoutes) {
    onLog(`[deploy] Accessible at: http://<server-ip>:${hostPort}`);
  }

  return { containerId, cName, hostPort };
}

// ── Core deployment flow ──────────────────────────────────────────────────────

export async function runDeployment(
  service: ServiceWithRoutes,
  deployment: Deployment,
  deps: DeployDeps = defaultDeps,
): Promise<void> {
  const logDir = serviceLogsDir(service.id);
  deps.mkdirSync(logDir, { recursive: true });
  const logPath = deploymentLogPath(service.id, deployment.id);
  const logStream = deps.createWriteStream(logPath, { flags: "a" });

  function onLog(line: string) {
    const ts = new Date().toISOString();
    const out = `[${ts}] ${line}\n`;
    logStream.write(out);
    process.stdout.write(out);
  }

  try {
    await deps.db.deployment.update({
      where: { id: deployment.id },
      data: { status: "building", startedAt: new Date(), logPath },
    });
    await deps.db.service.update({
      where: { id: service.id },
      data: { status: "building" },
    });

    await deps.createNetworkIfMissing();

    onLog(
      `[deploy] Starting deployment for service ${service.name} (${service.id})`,
    );

    // Mint a GitHub App token for private repos if needed
    let gitToken: string | null = null;
    if (service.repo.githubMode === "app") {
      gitToken = await deps.getInstallationToken(
        service.repo.repoOwner,
        service.repo.repoName,
      );
      if (gitToken) {
        onLog("[deploy] Acquired GitHub App installation token for clone");
      } else {
        onLog(
          "[deploy] Warning: GitHub App mode but could not acquire token — falling back to unauthenticated clone",
        );
      }
    }

    const { sha, message } = await deps.cloneOrPull({
      repoOwner: service.repo.repoOwner,
      repoName: service.repo.repoName,
      branch: service.branch,
      serviceId: service.id,
      token: gitToken,
      onLog,
    });

    await deps.db.deployment.update({
      where: { id: deployment.id },
      data: { commitSha: sha, commitMessage: message },
    });

    if (service.deployMode === "static") {
      await deployStatic(service, onLog, deps);
      await deps.db.deployment.update({
        where: { id: deployment.id },
        data: { status: "success", finishedAt: new Date() },
      });
      await deps.db.service.update({
        where: { id: service.id },
        data: { status: "running", containerId: null, containerName: null },
      });
    } else {
      const result = await deployServer(service, sha, onLog, deps);
      await deps.db.deployment.update({
        where: { id: deployment.id },
        data: { status: "success", finishedAt: new Date() },
      });
      await deps.db.service.update({
        where: { id: service.id },
        data: {
          status: "running",
          containerId: result.containerId,
          containerName: result.cName,
        },
      });
    }

    try {
      await deps.reloadCaddy();
      onLog("[deploy] Caddy config reloaded");
    } catch (err) {
      onLog(`[deploy] Warning: Caddy reload failed: ${(err as Error).message}`);
    }
  } catch (err) {
    await handleFailure(
      service,
      deployment,
      onLog,
      deps,
      (err as Error).message,
    );
  } finally {
    logStream.end();
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function enqueueDeployment(
  service: Service,
  deployment: Deployment,
  deps: DeployDeps = defaultDeps,
): void {
  const jobId = nanoid();

  deployQueue.enqueue({
    id: jobId,
    serviceId: service.id,
    deploymentId: deployment.id,
    run: async () => {
      const fullService = await deps.db.service.findUniqueOrThrow({
        where: { id: service.id },
        include: { repo: true, routes: { include: { domain: true } } },
      });
      await runDeployment(fullService as ServiceWithRoutes, deployment, deps);
    },
  });
}
