import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { router, settledProcedure } from '../trpc.js'
import { db } from '../lib/db.js'
import { enqueueDeployment } from '../services/deployment.js'
import { deployQueue } from '../lib/queue.js'
import fs from 'node:fs'

export const deployRouter = router({
  trigger: settledProcedure
    .input(z.object({
      projectId: z.string(),
      commitSha: z.string().optional(),
      commitMessage: z.string().optional(),
      triggeredBy: z.enum(['manual', 'webhook']).default('manual'),
    }))
    .mutation(async ({ input }) => {
      const project = await db.project.findUnique({ where: { id: input.projectId } })
      if (!project) throw new TRPCError({ code: 'NOT_FOUND', message: 'Project not found' })

      const deployment = await db.deployment.create({
        data: {
          projectId: input.projectId,
          status: 'queued',
          commitSha: input.commitSha ?? null,
          commitMessage: input.commitMessage ?? null,
          triggeredBy: input.triggeredBy,
        },
      })

      enqueueDeployment(project, deployment)

      return { deploymentId: deployment.id, status: 'queued' }
    }),

  list: settledProcedure
    .input(z.object({
      projectId: z.string(),
      limit: z.number().int().min(1).max(100).default(20),
    }))
    .query(({ input }) =>
      db.deployment.findMany({
        where: { projectId: input.projectId },
        orderBy: { createdAt: 'desc' },
        take: input.limit,
      }),
    ),

  get: settledProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const d = await db.deployment.findUnique({ where: { id: input.id } })
      if (!d) throw new TRPCError({ code: 'NOT_FOUND', message: 'Deployment not found' })
      return d
    }),

  getLogs: settledProcedure
    .input(z.object({
      deploymentId: z.string(),
      tail: z.number().int().min(1).max(1000).default(200),
    }))
    .query(async ({ input }) => {
      const deployment = await db.deployment.findUnique({ where: { id: input.deploymentId } })
      if (!deployment) throw new TRPCError({ code: 'NOT_FOUND', message: 'Deployment not found' })

      if (!deployment.logPath) return { lines: [], status: deployment.status }

      try {
        const content = fs.readFileSync(deployment.logPath, 'utf8')
        const lines = content.split('\n')
        const tail = lines.slice(-input.tail).filter(Boolean)
        return { lines: tail, status: deployment.status }
      } catch {
        return { lines: ['[log file not found]'], status: deployment.status }
      }
    }),

  queueStatus: settledProcedure
    .input(z.object({ projectId: z.string() }))
    .query(({ input }) => ({
      isRunning: deployQueue.isRunning(input.projectId),
      queued: deployQueue.queuedFor(input.projectId),
    })),
})
