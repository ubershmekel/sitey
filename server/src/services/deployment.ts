/**
 * Deployment orchestrator.
 * Wires together: git clone/pull → docker build → docker run → DB status updates.
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { Deployment, Project } from '@prisma/client'
import { db } from '../lib/db.js'
import { deployQueue } from '../lib/queue.js'
import {
  cloneOrPull,
  isTrackedFile,
  projectRootPath,
  projectRepoPath,
  projectDockerfilePath,
  deploymentLogPath,
  projectLogsDir,
} from './git.js'
import {
  buildImage,
  runOrReplaceContainer,
  createNetworkIfMissing,
  generateDefaultDockerfile,
  generateServerDockerfile,
  pruneProjectImages,
  allocateHostPort,
} from './docker.js'
import { reloadCaddy } from './caddy.js'
import { nanoid } from 'nanoid'

type RouteWithDomain = { domain: { hostname: string } | null; pathPrefix: string }
type ProjectWithRoutes = Project & { routes: RouteWithDomain[] }
type OnLog = (line: string) => void
type DockerBuildSource = {
  contextPath: string
  dockerfilePath: string
}

function containerName(project: Project): string {
  return `sitey-${project.id}`
}

function imageTag(project: Project, sha: string): string {
  const short = sha.slice(0, 12)
  return `sitey/${project.id}:${short}`
}

function buildManagedDockerfile(project: Project, onLog: OnLog): string {
  if (project.serverRunCommand) {
    onLog('[deploy] Auto mode: generating Sitey Dockerfile with custom run command')
    return generateServerDockerfile(
      project.buildCommand,
      project.serverRunCommand,
      project.containerPort,
      'repo',
    )
  }

  onLog('[deploy] Auto mode: generating default Sitey Node.js Dockerfile')
  return generateDefaultDockerfile(project.containerPort, 'repo')
}

function ensureManagedDockerfile(project: Project, managedDockerfilePath: string, onLog: OnLog): void {
  if (fs.existsSync(managedDockerfilePath)) {
    onLog(`[deploy] Auto mode: using existing managed Dockerfile: ${managedDockerfilePath}`)
    return
  }

  fs.mkdirSync(path.dirname(managedDockerfilePath), { recursive: true })
  fs.writeFileSync(managedDockerfilePath, buildManagedDockerfile(project, onLog))
  onLog(`[deploy] Wrote managed Dockerfile: ${managedDockerfilePath}`)
}

async function resolveDockerBuildSource(project: Project, onLog: OnLog): Promise<DockerBuildSource> {
  const projectRoot = projectRootPath(project.id)
  const repoPath = projectRepoPath(project.id)
  const managedDockerfilePath = projectDockerfilePath(project.id)
  const repoDockerfilePath = path.join(repoPath, 'Dockerfile')
  const repoDockerfileTracked =
    fs.existsSync(repoDockerfilePath) && await isTrackedFile(repoPath, 'Dockerfile')

  if (project.buildMode === 'dockerfile') {
    if (repoDockerfileTracked) {
      onLog('[deploy] Using tracked Dockerfile from repository root')
      return { contextPath: repoPath, dockerfilePath: repoDockerfilePath }
    }
    throw new Error('Build mode is dockerfile, but repository has no tracked Dockerfile at root')
  }

  if (repoDockerfileTracked) {
    onLog('[deploy] Using tracked Dockerfile from repository root')
    return { contextPath: repoPath, dockerfilePath: repoDockerfilePath }
  }

  ensureManagedDockerfile(project, managedDockerfilePath, onLog)
  return { contextPath: projectRoot, dockerfilePath: managedDockerfilePath }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function enqueueDeployment(project: Project, deployment: Deployment): void {
  const jobId = nanoid()

  deployQueue.enqueue({
    id: jobId,
    projectId: project.id,
    deploymentId: deployment.id,
    run: async () => {
      const fullProject = await db.project.findUniqueOrThrow({
        where: { id: project.id },
        include: { routes: { include: { domain: true } } },
      })
      await runDeployment(fullProject as ProjectWithRoutes, deployment)
    },
  })
}

// ── Core deployment flow ──────────────────────────────────────────────────────

async function runDeployment(project: ProjectWithRoutes, deployment: Deployment): Promise<void> {
  const logDir = projectLogsDir(project.id)
  fs.mkdirSync(logDir, { recursive: true })
  const logPath = deploymentLogPath(project.id, deployment.id)
  const logStream = fs.createWriteStream(logPath, { flags: 'a' })

  function onLog(line: string) {
    const ts = new Date().toISOString()
    const out = `[${ts}] ${line}\n`
    logStream.write(out)
    process.stdout.write(out)
  }

  async function fail(reason: string) {
    onLog(`[deploy] FAILED: ${reason}`)
    logStream.end()
    await db.deployment.update({
      where: { id: deployment.id },
      data: { status: 'failed', finishedAt: new Date(), logPath },
    })
    await db.project.update({
      where: { id: project.id },
      data: { status: 'failed' },
    })
  }

  try {
    // Mark started
    await db.deployment.update({
      where: { id: deployment.id },
      data: { status: 'building', startedAt: new Date(), logPath },
    })
    await db.project.update({ where: { id: project.id }, data: { status: 'building' } })

    // 1. Ensure network
    await createNetworkIfMissing()

    // 2. Git clone / pull
    onLog(`[deploy] Starting deployment for project ${project.name} (${project.id})`)
    const { sha, message } = await cloneOrPull({
      repoOwner: project.repoOwner,
      repoName: project.repoName,
      branch: project.branch,
      projectId: project.id,
      onLog,
    })

    await db.deployment.update({
      where: { id: deployment.id },
      data: { commitSha: sha, commitMessage: message },
    })

    if (project.deployMode === 'static') {
      // 3. Run build command in the repo directory (node/npm available in this container)
      const repoPath = projectRepoPath(project.id)
      const buildCmd = project.buildCommand.trim() || 'echo "No build step"'
      onLog(`[deploy] Running build: ${buildCmd}`)
      await new Promise<void>((resolve, reject) => {
        const proc = spawn('sh', ['-c', buildCmd], { cwd: repoPath })
        proc.stdout.on('data', (d: Buffer) => onLog(d.toString().trimEnd()))
        proc.stderr.on('data', (d: Buffer) => onLog(d.toString().trimEnd()))
        proc.on('close', (code: number | null) => code === 0 ? resolve() : reject(new Error(`Build exited with code ${code}`)))
        proc.on('error', reject)
      })

      // 4. Push updated Caddy config (serves repo/<outputDir> directly)
      try {
        await reloadCaddy()
        onLog('[deploy] Caddy config reloaded')
      } catch (err) {
        onLog(`[deploy] Warning: Caddy reload failed: ${(err as Error).message}`)
      }

      // 5. Mark success
      onLog(`[deploy] Static deployment successful! Serving from ${repoPath}/${project.outputDir}`)
      logStream.end()
      await db.deployment.update({ where: { id: deployment.id }, data: { status: 'success', finishedAt: new Date() } })
      await db.project.update({ where: { id: project.id }, data: { status: 'running', containerId: null, containerName: null } })
      return
    }

    // 3. Resolve Dockerfile strategy
    const dockerBuild = await resolveDockerBuildSource(project, onLog)
    const dockerfile = path
      .relative(dockerBuild.contextPath, dockerBuild.dockerfilePath)
      .split(path.sep)
      .join('/')

    // 4. Build image
    const tag = imageTag(project, sha)
    await buildImage({
      projectId: project.id,
      contextPath: dockerBuild.contextPath,
      tag,
      dockerfile,
      onLog,
    })

    // 5. Resolve host port fallback (used when the project has no routable routes)
    const hasRoutableRoutes = project.routes.some((r: RouteWithDomain) => r.domain || r.pathPrefix)
    let hostPort = project.hostPort
    if (!hasRoutableRoutes && hostPort === null) {
      hostPort = await allocateHostPort()
      await db.project.update({ where: { id: project.id }, data: { hostPort } })
      onLog(`[deploy] No routes configured — assigned fallback host port ${hostPort}`)
    }

    // 6. Run container
    const envVars: Record<string, string> = {}
    try {
      Object.assign(envVars, JSON.parse(project.envVars || '{}'))
    } catch { /* ignore */ }
    envVars['PORT'] = String(project.containerPort)

    const cName = containerName(project)
    const containerId = await runOrReplaceContainer({
      project,
      imageTag: tag,
      containerName: cName,
      envVars,
      hostPort,
      onLog,
    })

    // 7. Prune old images for this project
    await pruneProjectImages(project.id, tag)

    // 8. Push updated Caddy config (new container is now reachable)
    try {
      await reloadCaddy()
      onLog('[deploy] Caddy config reloaded')
    } catch (err) {
      onLog(`[deploy] Warning: Caddy reload failed: ${(err as Error).message}`)
    }

    // 9. Mark success
    onLog(`[deploy] Deployment successful! Container: ${cName} (${containerId.slice(0, 12)})`)
    if (hostPort && !hasRoutableRoutes) {
      onLog(`[deploy] Accessible at: http://<server-ip>:${hostPort}`)
    }
    logStream.end()

    await db.deployment.update({
      where: { id: deployment.id },
      data: { status: 'success', finishedAt: new Date() },
    })
    await db.project.update({
      where: { id: project.id },
      data: { status: 'running', containerId, containerName: cName },
    })
  } catch (err) {
    await fail((err as Error).message)
  }
}
