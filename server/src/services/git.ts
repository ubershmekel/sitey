import simpleGit from 'simple-git'
import path from 'node:path'
import fs from 'node:fs'

const DATA_ROOT = process.env.DATA_ROOT ?? '/opt/sitey'

export function projectRepoPath(projectId: string): string {
  return path.join(DATA_ROOT, 'projects', projectId, 'repo')
}

export function projectLogsDir(projectId: string): string {
  return path.join(DATA_ROOT, 'projects', projectId, 'logs')
}

export function deploymentLogPath(projectId: string, deploymentId: string): string {
  return path.join(projectLogsDir(projectId), `${deploymentId}.log`)
}

/**
 * Clone or pull the latest commits for a project.
 * Returns the HEAD commit SHA after the operation.
 */
export async function cloneOrPull(opts: {
  repoOwner: string
  repoName: string
  branch: string
  projectId: string
  onLog: (line: string) => void
}): Promise<{ sha: string; message: string }> {
  const { repoOwner, repoName, branch, projectId, onLog } = opts
  const repoUrl = `https://github.com/${repoOwner}/${repoName}.git`
  const repoPath = projectRepoPath(projectId)

  fs.mkdirSync(path.dirname(repoPath), { recursive: true })

  if (fs.existsSync(path.join(repoPath, '.git'))) {
    onLog(`[git] Pulling latest from ${repoUrl} (${branch})`)
    const git = simpleGit(repoPath)
    await git.fetch('origin')
    await git.checkout(branch)
    await git.pull('origin', branch, { '--ff-only': null })
  } else {
    onLog(`[git] Cloning ${repoUrl} (${branch}) → ${repoPath}`)
    fs.mkdirSync(repoPath, { recursive: true })
    const git = simpleGit()
    await git.clone(repoUrl, repoPath, ['--branch', branch, '--single-branch'])
  }

  const git = simpleGit(repoPath)
  const log = await git.log({ maxCount: 1 })
  const latest = log.latest
  return {
    sha: latest?.hash ?? 'unknown',
    message: latest?.message ?? '',
  }
}
