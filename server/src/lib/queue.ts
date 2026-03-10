/**
 * Simple in-memory deployment queue.
 * Single-instance only — does not survive restarts.
 * Jobs are processed one-at-a-time per project to avoid concurrent builds.
 */

type Job = {
  id: string
  projectId: number
  deploymentId: string
  run: () => Promise<void>
}

class DeploymentQueue {
  private queue: Job[] = []
  private running = new Set<number>() // projectIds currently building

  enqueue(job: Job) {
    this.queue.push(job)
    this.processNext()
  }

  private async processNext() {
    const pending = this.queue.find(j => !this.running.has(j.projectId))
    if (!pending) return

    this.queue = this.queue.filter(j => j.id !== pending.id)
    this.running.add(pending.projectId)

    try {
      await pending.run()
    } catch (err) {
      console.error(`[queue] Job ${pending.id} failed:`, err)
    } finally {
      this.running.delete(pending.projectId)
      this.processNext()
    }
  }

  isRunning(projectId: number) {
    return this.running.has(projectId)
  }

  queuedFor(projectId: number) {
    return this.queue.filter(j => j.projectId === projectId).length
  }
}

export const deployQueue = new DeploymentQueue()
