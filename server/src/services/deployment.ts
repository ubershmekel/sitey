/**
 * Deployment orchestrator.
 * Wires together: git clone/pull → docker build → docker run → DB status updates.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { Deployment, Project } from '@prisma/client'
import { db } from '../lib/db.js'
import { deployQueue } from '../lib/queue.js'
import { cloneOrPull, projectRepoPath, deploymentLogPath, projectLogsDir } from './git.js'
import {
  buildImage,
  runOrReplaceContainer,
  createNetworkIfMissing,
  generateDefaultDockerfile,
  generateServerDockerfile,
  generateStaticDockerfile,
  pruneProjectImages,
  allocateHostPort,
} from './docker.js'
import { nanoid } from 'nanoid'

type RouteWithDomain = { domain: { hostname: string } | null; pathPrefix: string }
type ProjectWithRoutes = Project & { routes: RouteWithDomain[] }

function containerName(project: Project): string {
  return `sitey-${project.id}`
}

function imageTag(project: Project, sha: string): string {
  const short = sha.slice(0, 12)
  return `sitey/${project.id}:${short}`
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

    // 3. Ensure Dockerfile exists (auto mode)
    const repoPath = projectRepoPath(project.id)
    const dockerfilePath = path.join(repoPath, 'Dockerfile')

    if (project.buildMode === 'auto' && !fs.existsSync(dockerfilePath)) {
      if (project.deployMode === 'static') {
        onLog('[deploy] No Dockerfile found — generating static site Dockerfile')
        fs.writeFileSync(
          dockerfilePath,
          generateStaticDockerfile(project.buildCommand, project.outputDir, project.containerPort),
        )
      } else if (project.serverRunCommand) {
        onLog('[deploy] No Dockerfile found — generating server Dockerfile with custom run command')
        fs.writeFileSync(
          dockerfilePath,
          generateServerDockerfile(project.buildCommand, project.serverRunCommand, project.containerPort),
        )
      } else {
        onLog('[deploy] No Dockerfile found — generating default Node.js Dockerfile')
        fs.writeFileSync(dockerfilePath, generateDefaultDockerfile(project.containerPort))
      }
    }

    // 4. Build image
    const tag = imageTag(project, sha)
    await buildImage({ projectId: project.id, repoPath, tag, onLog })

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
      routes: project.routes,
      imageTag: tag,
      containerName: cName,
      envVars,
      hostPort,
      onLog,
    })

    // 7. Prune old images for this project
    await pruneProjectImages(project.id, tag)

    // 8. Mark success
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
