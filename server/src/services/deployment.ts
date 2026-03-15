/**
 * Deployment orchestrator.
 * Wires together: git clone/pull → docker build → docker run → DB status updates.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Deployment, Project } from "../generated/prisma/client.js";
import { db } from "../lib/db.js";
import { deployQueue } from "../lib/queue.js";
import {
  cloneOrPull,
  isTrackedFile,
  projectRootPath,
  projectRepoPath,
  projectDockerfilePath,
  deploymentLogPath,
  projectLogsDir,
} from "./git.js";
import {
  docker,
  buildImage,
  runOrReplaceContainer,
  stopAndRemoveContainer,
  createNetworkIfMissing,
  generateDefaultDockerfile,
  generateServerDockerfile,
  pruneProjectImages,
  allocateHostPort,
} from "./docker.js";
import { reloadCaddy } from "./caddy.js";
import { getInstallationToken } from "./github.js";
import { nanoid } from "nanoid";

type RouteWithDomain = {
  domain: { hostname: string } | null;
  pathPrefix: string;
};
type ProjectWithRoutes = Project & { routes: RouteWithDomain[] };
type OnLog = (line: string) => void;
type DockerBuildSource = {
  contextPath: string;
  dockerfilePath: string;
};

function containerName(project: Project): string {
  return `sitey-project-${project.id}`;
}

function imageTag(project: Project, sha: string): string {
  const short = sha.slice(0, 12);
  return `sitey/${project.id}:${short}`;
}

function buildManagedDockerfile(project: Project, onLog: OnLog): string {
  if (project.serverRunCommand) {
    onLog(
      "[deploy] Auto mode: generating Sitey Dockerfile with custom run command",
    );
    return generateServerDockerfile(
      project.buildCommand,
      project.serverRunCommand,
      project.containerPort,
      "repo",
    );
  }

  onLog("[deploy] Auto mode: generating default Sitey Node.js Dockerfile");
  return generateDefaultDockerfile(project.containerPort, "repo");
}

function ensureManagedDockerfile(
  project: Project,
  managedDockerfilePath: string,
  onLog: OnLog,
): void {
  if (fs.existsSync(managedDockerfilePath)) {
    onLog(
      `[deploy] Auto mode: using existing managed Dockerfile: ${managedDockerfilePath}`,
    );
    return;
  }

  fs.mkdirSync(path.dirname(managedDockerfilePath), { recursive: true });
  fs.writeFileSync(
    managedDockerfilePath,
    buildManagedDockerfile(project, onLog),
  );
  onLog(`[deploy] Wrote managed Dockerfile: ${managedDockerfilePath}`);
}

async function resolveDockerBuildSource(
  project: Project,
  onLog: OnLog,
): Promise<DockerBuildSource> {
  const projectRoot = projectRootPath(project.id);
  const repoPath = projectRepoPath(project.id);
  const managedDockerfilePath = projectDockerfilePath(project.id);
  const dockerfileRelPath = project.dockerfilePath || "Dockerfile";
  const repoDockerfilePath = path.join(repoPath, dockerfileRelPath);
  const repoDockerfileTracked =
    fs.existsSync(repoDockerfilePath) &&
    (await isTrackedFile(repoPath, dockerfileRelPath));

  if (project.buildMode === "dockerfile") {
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

  ensureManagedDockerfile(project, managedDockerfilePath, onLog);
  return { contextPath: projectRoot, dockerfilePath: managedDockerfilePath };
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
  project: Project,
  deployment: Deployment,
): void {
  const jobId = nanoid();

  deployQueue.enqueue({
    id: jobId,
    projectId: project.id,
    deploymentId: deployment.id,
    run: async () => {
      const fullProject = await db.project.findUniqueOrThrow({
        where: { id: project.id },
        include: { routes: { include: { domain: true } } },
      });
      await runDeployment(fullProject as ProjectWithRoutes, deployment);
    },
  });
}

// ── Core deployment flow ──────────────────────────────────────────────────────

async function runDeployment(
  project: ProjectWithRoutes,
  deployment: Deployment,
): Promise<void> {
  const logDir = projectLogsDir(project.id);
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = deploymentLogPath(project.id, deployment.id);
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
    await db.project.update({
      where: { id: project.id },
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
    await db.project.update({
      where: { id: project.id },
      data: { status: "building" },
    });

    // 1. Ensure network
    await createNetworkIfMissing();

    // 2. Git clone / pull
    onLog(
      `[deploy] Starting deployment for project ${project.name} (${project.id})`,
    );

    // For GitHub App projects, mint a short-lived installation token so
    // we can clone/pull private repos.
    let gitToken: string | null = null;
    if (project.githubMode === "app") {
      gitToken = await getInstallationToken(
        project.repoOwner,
        project.repoName,
      );
      if (gitToken) {
        onLog("[deploy] Acquired GitHub App installation token for clone");
      } else {
        onLog(
          "[deploy] Warning: GitHub App mode but could not acquire token — falling back to unauthenticated clone",
        );
      }
    }

    const { sha, message } = await cloneOrPull({
      repoOwner: project.repoOwner,
      repoName: project.repoName,
      branch: project.branch,
      projectId: project.id,
      token: gitToken,
      onLog,
    });

    await db.deployment.update({
      where: { id: deployment.id },
      data: { commitSha: sha, commitMessage: message },
    });

    if (project.deployMode === "static") {
      // 3. Run build command in the repo directory (node/npm available in this container)
      const repoPath = projectRepoPath(project.id);
      const buildCmd = project.buildCommand.trim() || 'echo "No build step"';
      onLog(`[deploy] Running build: ${buildCmd}`);
      const buildEnv = parseEnvString(project.envVars || "");
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

      // 4. Push updated Caddy config (serves repo/<outputDir> directly)
      try {
        await reloadCaddy();
        onLog("[deploy] Caddy config reloaded");
      } catch (err) {
        onLog(
          `[deploy] Warning: Caddy reload failed: ${(err as Error).message}`,
        );
      }

      // 5. Mark success
      onLog(
        `[deploy] Static deployment successful! Serving from ${repoPath}/${project.outputDir}`,
      );
      logStream.end();
      await db.deployment.update({
        where: { id: deployment.id },
        data: { status: "success", finishedAt: new Date() },
      });
      await db.project.update({
        where: { id: project.id },
        data: { status: "running", containerId: null, containerName: null },
      });
      return;
    }

    // 3. Resolve Dockerfile strategy
    const dockerBuild = await resolveDockerBuildSource(project, onLog);
    const dockerfile = path
      .relative(dockerBuild.contextPath, dockerBuild.dockerfilePath)
      .split(path.sep)
      .join("/");

    // 4. Build image
    const tag = imageTag(project, sha);
    await buildImage({
      projectId: project.id,
      contextPath: dockerBuild.contextPath,
      tag,
      dockerfile,
      onLog,
    });

    // 5. Resolve host port fallback (used when the project has no routable routes)
    const hasRoutableRoutes = project.routes.some(
      (r: RouteWithDomain) => r.domain || r.pathPrefix,
    );
    let hostPort = project.hostPort;
    if (!hasRoutableRoutes && hostPort === null) {
      hostPort = await allocateHostPort();
      await db.project.update({
        where: { id: project.id },
        data: { hostPort },
      });
      onLog(
        `[deploy] No routes configured — assigned fallback host port ${hostPort}`,
      );
    }

    // 6. Run container
    const envVars = parseEnvString(project.envVars || "");
    envVars["PORT"] = String(project.containerPort);
    envVars["DATA_DIR"] = "/data";

    const cName = containerName(project);
    const legacyContainerName = `sitey-${project.id}`;
    if (legacyContainerName !== cName) {
      await stopAndRemoveContainer(legacyContainerName, onLog);
    }
    const containerId = await runOrReplaceContainer({
      project,
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

    // 7. Prune old images for this project
    await pruneProjectImages(project.id, tag);

    // 8. Push updated Caddy config (new container is now reachable)
    try {
      await reloadCaddy();
      onLog("[deploy] Caddy config reloaded");
    } catch (err) {
      onLog(`[deploy] Warning: Caddy reload failed: ${(err as Error).message}`);
    }

    // 9. Mark success
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
    await db.project.update({
      where: { id: project.id },
      data: { status: "running", containerId, containerName: cName },
    });
  } catch (err) {
    await fail((err as Error).message);
  }
}
