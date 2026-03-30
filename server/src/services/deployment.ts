/**
 * Deployment orchestrator.
 * Wires together: git clone/pull → docker build → docker run → DB status updates.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Deployment, Service, Repo } from "../generated/prisma/client.ts";
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
type DockerBuildSource = {
  contextPath: string;
  dockerfilePath: string;
};

function containerName(service: Service): string {
  return `sitey-service-${service.id}`;
}

function imageTag(service: Service, sha: string): string {
  const short = sha.slice(0, 12);
  return `sitey/${service.id}:${short}`;
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

async function getKeepTags(
  service: Service,
  currentTag: string,
): Promise<string[]> {
  const cfg = await db.systemConfig.findUnique({
    where: { key: "cleanup_rollback_count" },
  });
  const n = parseRollbackCount(cfg?.value);
  if (n === 0) return [currentTag];

  const previous = await db.deployment.findMany({
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

function buildManagedDockerfile(service: Service): string {
  return generateDockerfile(
    service.buildCommand,
    service.serverRunCommand,
    service.containerPort,
    "repo",
    service.buildImage || undefined,
  );
}

function ensureManagedDockerfile(
  service: Service,
  managedDockerfilePath: string,
  onLog: OnLog,
): void {
  fs.mkdirSync(path.dirname(managedDockerfilePath), { recursive: true });
  fs.writeFileSync(managedDockerfilePath, buildManagedDockerfile(service));
  onLog(`[deploy] Wrote managed Dockerfile: ${managedDockerfilePath}`);
}

async function resolveDockerBuildSource(
  service: Service,
  onLog: OnLog,
): Promise<DockerBuildSource> {
  const svcRoot = serviceRootPath(service.id);
  const repoPath = serviceRepoPath(service.id);
  const managedDockerfilePath = serviceDockerfilePath(service.id);
  const dockerfileRelPath = service.dockerfilePath || "Dockerfile";
  const repoDockerfilePath = path.join(repoPath, dockerfileRelPath);
  const repoDockerfileTracked =
    fs.existsSync(repoDockerfilePath) &&
    (await isTrackedFile(repoPath, dockerfileRelPath));

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

  ensureManagedDockerfile(service, managedDockerfilePath, onLog);
  return { contextPath: svcRoot, dockerfilePath: managedDockerfilePath };
}

// ── .env parser ──────────────────────────────────────────────────────────────

function parseEnvString(raw: string): Record<string, string> {
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

// ── Public API ────────────────────────────────────────────────────────────────

export function enqueueDeployment(
  service: Service,
  deployment: Deployment,
): void {
  const jobId = nanoid();

  deployQueue.enqueue({
    id: jobId,
    serviceId: service.id,
    deploymentId: deployment.id,
    run: async () => {
      const fullService = await db.service.findUniqueOrThrow({
        where: { id: service.id },
        include: { repo: true, routes: { include: { domain: true } } },
      });
      await runDeployment(fullService as ServiceWithRoutes, deployment);
    },
  });
}

// ── Core deployment flow ──────────────────────────────────────────────────────

async function runDeployment(
  service: ServiceWithRoutes,
  deployment: Deployment,
): Promise<void> {
  const logDir = serviceLogsDir(service.id);
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = deploymentLogPath(service.id, deployment.id);
  const logStream = fs.createWriteStream(logPath, { flags: "a" });

  function onLog(line: string) {
    const ts = new Date().toISOString();
    const out = `[${ts}] ${line}\n`;
    logStream.write(out);
    process.stdout.write(out);
  }

  async function fail(reason: string) {
    onLog(`[deploy] FAILED: ${reason}`);
    logStream.end();
    await db.deployment.update({
      where: { id: deployment.id },
      data: { status: "failed", finishedAt: new Date(), logPath },
    });
    await db.service.update({
      where: { id: service.id },
      data: { status: "failed", containerId: null, containerName: null },
    });
    try {
      await reloadCaddy();
      onLog("[deploy] Caddy config reloaded after failure");
    } catch (err) {
      onLog(
        `[deploy] Warning: Caddy reload failed after failure: ${(err as Error).message}`,
      );
    }
  }

  try {
    // Mark started
    await db.deployment.update({
      where: { id: deployment.id },
      data: { status: "building", startedAt: new Date(), logPath },
    });
    await db.service.update({
      where: { id: service.id },
      data: { status: "building" },
    });

    // 1. Ensure network
    await createNetworkIfMissing();

    // 2. Git clone / pull
    const repo = service.repo;
    onLog(
      `[deploy] Starting deployment for service ${service.name} (${service.id})`,
    );

    // For GitHub App repos, mint a short-lived installation token so
    // we can clone/pull private repos.
    let gitToken: string | null = null;
    if (repo.githubMode === "app") {
      gitToken = await getInstallationToken(repo.repoOwner, repo.repoName);
      if (gitToken) {
        onLog("[deploy] Acquired GitHub App installation token for clone");
      } else {
        onLog(
          "[deploy] Warning: GitHub App mode but could not acquire token — falling back to unauthenticated clone",
        );
      }
    }

    const { sha, message } = await cloneOrPull({
      repoOwner: repo.repoOwner,
      repoName: repo.repoName,
      branch: service.branch,
      serviceId: service.id,
      token: gitToken,
      onLog,
    });

    await db.deployment.update({
      where: { id: deployment.id },
      data: { commitSha: sha, commitMessage: message },
    });

    if (service.deployMode === "static") {
      // 3. Run build command
      const repoPath = serviceRepoPath(service.id);
      const buildCmd = service.buildCommand.trim() || 'echo "No build step"';
      onLog(`[deploy] Running build: ${buildCmd}`);
      const buildEnv = parseEnvString(service.envVars || "");

      if (service.buildImage) {
        // Run build inside a Docker container (e.g. oven/bun:1)
        await runBuildContainer({
          serviceId: service.id,
          buildImage: service.buildImage,
          buildCommand: buildCmd,
          envVars: buildEnv,
          onLog,
        });
      } else {
        // Run build directly in the sitey-api container (node/npm available)
        await new Promise<void>((resolve, reject) => {
          const proc = spawn("sh", ["-c", buildCmd], {
            cwd: repoPath,
            env: { ...process.env, ...buildEnv },
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

      // 4. Mark success (must happen before Caddy reload so buildCaddyfile sees status=running)
      onLog(
        `[deploy] Static deployment successful! Serving from ${repoPath}/${service.outputDir}`,
      );
      logStream.end();
      await db.deployment.update({
        where: { id: deployment.id },
        data: { status: "success", finishedAt: new Date() },
      });
      await db.service.update({
        where: { id: service.id },
        data: { status: "running", containerId: null, containerName: null },
      });

      // 5. Push updated Caddy config (serves repo/<outputDir> directly)
      try {
        await reloadCaddy();
        onLog("[deploy] Caddy config reloaded");
      } catch (err) {
        onLog(
          `[deploy] Warning: Caddy reload failed: ${(err as Error).message}`,
        );
      }
      return;
    }

    // 3. Resolve Dockerfile strategy
    const dockerBuild = await resolveDockerBuildSource(service, onLog);
    const dockerfile = path
      .relative(dockerBuild.contextPath, dockerBuild.dockerfilePath)
      .split(path.sep)
      .join("/");

    // 4. Build image
    const tag = imageTag(service, sha);
    await buildImage({
      serviceId: service.id,
      contextPath: dockerBuild.contextPath,
      tag,
      dockerfile,
      onLog,
    });

    // 5. Resolve host port fallback (used when the service has no routable routes)
    const hasRoutableRoutes = service.routes.some(
      (r: RouteWithDomain) => r.domain || r.pathPrefix,
    );
    let hostPort = service.hostPort;
    if (!hasRoutableRoutes && hostPort === null) {
      hostPort = await allocateHostPort();
      await db.service.update({
        where: { id: service.id },
        data: { hostPort },
      });
      onLog(
        `[deploy] No routes configured — assigned fallback host port ${hostPort}`,
      );
    }

    // 6. Run container
    const envVars = parseEnvString(service.envVars || "");
    envVars["PORT"] = String(service.containerPort);
    envVars["DATA_DIR"] = "/data";

    const cName = containerName(service);
    // Clean up legacy container names from before the rename
    const legacyNames = [`sitey-project-${service.id}`, `sitey-${service.id}`];
    for (const legacy of legacyNames) {
      if (legacy !== cName) {
        await stopAndRemoveContainer(legacy, onLog);
      }
    }
    const containerId = await runOrReplaceContainer({
      service,
      imageTag: tag,
      containerName: cName,
      envVars,
      hostPort,
      onLog,
    });

    // Give the app a brief window to crash fast (missing env, bad entrypoint, etc).
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const inspected = await docker.getContainer(containerId).inspect();
    if (!inspected.State.Running) {
      throw new Error(
        `Container exited right after start (state: ${inspected.State.Status}). Check container logs.`,
      );
    }

    // 7. Prune old images for this service
    const keepTags = await getKeepTags(service, tag);
    await pruneServiceImages(service.id, keepTags, onLog);

    // 8. Mark success (must happen before Caddy reload so buildCaddyfile sees containerName)
    onLog(
      `[deploy] Deployment successful! Container: ${cName} (${containerId.slice(0, 12)})`,
    );
    if (hostPort && !hasRoutableRoutes) {
      onLog(`[deploy] Accessible at: http://<server-ip>:${hostPort}`);
    }
    logStream.end();

    await db.deployment.update({
      where: { id: deployment.id },
      data: { status: "success", finishedAt: new Date() },
    });
    await db.service.update({
      where: { id: service.id },
      data: { status: "running", containerId, containerName: cName },
    });

    // 9. Push updated Caddy config (new container is now reachable)
    try {
      await reloadCaddy();
      onLog("[deploy] Caddy config reloaded");
    } catch (err) {
      onLog(`[deploy] Warning: Caddy reload failed: ${(err as Error).message}`);
    }
  } catch (err) {
    await fail((err as Error).message);
  }
}
