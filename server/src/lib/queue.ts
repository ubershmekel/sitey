/**
 * Simple in-memory deployment queue.
 * Single-instance only — does not survive restarts.
 * Jobs are processed one-at-a-time per service to avoid concurrent builds.
 */

type Job = {
  id: string;
  serviceId: number;
  deploymentId: string;
  run: () => Promise<void>;
};

class DeploymentQueue {
  private queue: Job[] = [];
  private running = new Set<number>(); // serviceIds currently building

  enqueue(job: Job) {
    this.queue.push(job);
    this.processNext();
  }

  private async processNext() {
    const pending = this.queue.find((j) => !this.running.has(j.serviceId));
    if (!pending) return;

    this.queue = this.queue.filter((j) => j.id !== pending.id);
    this.running.add(pending.serviceId);

    try {
      await pending.run();
    } catch (err) {
      console.error(`[queue] Job ${pending.id} failed:`, err);
    } finally {
      this.running.delete(pending.serviceId);
      this.processNext();
    }
  }

  isRunning(serviceId: number) {
    return this.running.has(serviceId);
  }

  queuedFor(serviceId: number) {
    return this.queue.filter((j) => j.serviceId === serviceId).length;
  }
}

export const deployQueue = new DeploymentQueue();
