import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { router, settledProcedure } from '../trpc.js'
import { db } from '../lib/db.js'
import { generateWebhookSecret } from '../services/crypto.js'

export const projectsRouter = router({
  listByDomain: settledProcedure
    .input(z.object({ domainId: z.string() }))
    .query(({ input }) =>
      db.project.findMany({
        where: { domainId: input.domainId },
        orderBy: { createdAt: 'desc' },
        include: {
          deployments: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
      }),
    ),

  get: settledProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const project = await db.project.findUnique({
        where: { id: input.id },
        include: {
          domain: true,
          deployments: { orderBy: { createdAt: 'desc' }, take: 5 },
        },
      })
      if (!project) throw new TRPCError({ code: 'NOT_FOUND', message: 'Project not found' })
      return project
    }),

  create: settledProcedure
    .input(z.object({
      domainId: z.string(),
      name: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/, 'Lowercase alphanumeric and hyphens only'),
      repoOwner: z.string().min(1),
      repoName: z.string().min(1),
      branch: z.string().default('main'),
      subdomain: z.string().default(''),
      buildMode: z.enum(['auto', 'dockerfile']).default('auto'),
      containerPort: z.number().int().min(1).max(65535).default(3000),
      envVars: z.record(z.string()).default({}),
      githubMode: z.enum(['webhook', 'app']).default('webhook'),
    }))
    .mutation(async ({ input }) => {
      const domain = await db.domain.findUnique({ where: { id: input.domainId } })
      if (!domain) throw new TRPCError({ code: 'NOT_FOUND', message: 'Domain not found' })

      const webhookSecret = generateWebhookSecret()

      return db.project.create({
        data: {
          ...input,
          envVars: JSON.stringify(input.envVars),
          webhookSecret,
        },
      })
    }),

  update: settledProcedure
    .input(z.object({
      id: z.string(),
      branch: z.string().optional(),
      subdomain: z.string().optional(),
      buildMode: z.enum(['auto', 'dockerfile']).optional(),
      containerPort: z.number().int().min(1).max(65535).optional(),
      envVars: z.record(z.string()).optional(),
      githubMode: z.enum(['webhook', 'app']).optional(),
    }))
    .mutation(async ({ input }) => {
      const { id, envVars, ...rest } = input
      return db.project.update({
        where: { id },
        data: {
          ...rest,
          ...(envVars !== undefined ? { envVars: JSON.stringify(envVars) } : {}),
        },
      })
    }),

  delete: settledProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      await db.project.delete({ where: { id: input.id } })
      return { ok: true }
    }),

  rotateWebhookSecret: settledProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const secret = generateWebhookSecret()
      await db.project.update({ where: { id: input.id }, data: { webhookSecret: secret } })
      return { webhookSecret: secret }
    }),

  getWebhookInfo: settledProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const project = await db.project.findUniqueOrThrow({
        where: { id: input.id },
        select: { webhookSecret: true, githubMode: true, domain: { select: { hostname: true } } },
      })
      const siteUrl = process.env.SITEY_URL ?? `http://localhost:3001`
      return {
        webhookUrl: `${siteUrl}/webhook/github/${input.id}`,
        webhookSecret: project.webhookSecret,
        githubMode: project.githubMode,
      }
    }),
})
