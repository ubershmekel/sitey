import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { customAlphabet } from 'nanoid'
import { router, settledProcedure } from '../trpc.js'
import { db } from '../lib/db.js'
import { generateWebhookSecret } from '../services/crypto.js'

const SUBDOMAIN_LABEL_REGEX = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const randomSubdomainSuffix = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 5)

function isWildcardDomain(hostname: string): boolean {
  return hostname.startsWith('*.')
}

function slugifySubdomainSeed(input: string): string {
  const cleaned = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned || 'project'
}

function buildSubdomainCandidate(seed: string): string {
  const suffix = randomSubdomainSuffix()
  const maxSeedLength = 63 - suffix.length - 1
  const trimmedSeed = seed.slice(0, Math.max(1, maxSeedLength)).replace(/-+$/g, '')
  const finalSeed = trimmedSeed || 'project'
  return `${finalSeed}-${suffix}`
}

async function generateUniqueSubdomain(domainId: string, projectName: string): Promise<string> {
  const seed = slugifySubdomainSeed(projectName)
  for (let i = 0; i < 20; i += 1) {
    const candidate = buildSubdomainCandidate(seed)
    const existing = await db.projectRoute.findFirst({
      where: { domainId, subdomain: candidate },
      select: { id: true },
    })
    if (!existing) return candidate
  }
  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Could not allocate a unique subdomain. Please retry.',
  })
}

export const projectsRouter = router({
  list: settledProcedure
    .query(() =>
      db.project.findMany({
        orderBy: { createdAt: 'desc' },
        include: {
          routes: { include: { domain: true } },
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
          routes: { include: { domain: true } },
          deployments: { orderBy: { createdAt: 'desc' }, take: 5 },
        },
      })
      if (!project) throw new TRPCError({ code: 'NOT_FOUND', message: 'Project not found' })
      return project
    }),

  create: settledProcedure
    .input(z.object({
      name: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/, 'Lowercase alphanumeric and hyphens only'),
      repoOwner: z.string().min(1),
      repoName: z.string().min(1),
      branch: z.string().default('main'),
      deployMode: z.enum(['server', 'static']).default('server'),
      buildCommand: z.string().default(''),
      outputDir: z.string().default('dist'),
      serverRunCommand: z.string().default(''),
      buildMode: z.enum(['auto', 'dockerfile']).default('auto'),
      containerPort: z.number().int().min(1).max(65535).default(3000),
      envVars: z.record(z.string()).default({}),
      githubMode: z.enum(['webhook', 'app']).default('webhook'),
    }))
    .mutation(async ({ input }) => {
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
      deployMode: z.enum(['server', 'static']).optional(),
      buildCommand: z.string().optional(),
      outputDir: z.string().optional(),
      serverRunCommand: z.string().optional(),
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
      const project = await db.project.findUnique({ where: { id: input.id } })
      if (!project) throw new TRPCError({ code: 'NOT_FOUND', message: 'Project not found' })
      if (project.protected) throw new TRPCError({ code: 'FORBIDDEN', message: 'This project cannot be deleted' })
      await db.project.delete({ where: { id: input.id } })
      return { ok: true }
    }),

  // ── Routes ─────────────────────────────────────────────────────────────────

  addRoute: settledProcedure
    .input(z.object({
      projectId: z.string(),
      domainId: z.string().optional(),
      pathPrefix: z.string().default(''),
      subdomain: z.string().default(''),
    }))
    .mutation(async ({ input }) => {
      const project = await db.project.findUnique({
        where: { id: input.projectId },
        select: { id: true, name: true },
      })
      if (!project) throw new TRPCError({ code: 'NOT_FOUND', message: 'Project not found' })

      let domain: { id: string; hostname: string } | null = null
      if (input.domainId) {
        domain = await db.domain.findUnique({
          where: { id: input.domainId },
          select: { id: true, hostname: true },
        })
        if (!domain) throw new TRPCError({ code: 'NOT_FOUND', message: 'Domain not found' })
      }

      let subdomain = input.subdomain.trim().toLowerCase()
      if (domain && isWildcardDomain(domain.hostname)) {
        if (!subdomain) {
          subdomain = await generateUniqueSubdomain(domain.id, project.name)
        } else if (!SUBDOMAIN_LABEL_REGEX.test(subdomain)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Subdomain must be a valid DNS label (lowercase letters, numbers, hyphens).',
          })
        }
      } else {
        if (subdomain) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Subdomain can only be set when using a wildcard domain.',
          })
        }
        subdomain = ''
      }

      try {
        return await db.projectRoute.create({
          data: {
            projectId: input.projectId,
            domainId: input.domainId,
            pathPrefix: input.pathPrefix,
            subdomain,
          },
        })
      } catch (err) {
        const code = (err as { code?: string }).code
        if (code === 'P2002') {
          throw new TRPCError({ code: 'CONFLICT', message: 'Route already exists for this host/path.' })
        }
        throw err
      }
    }),

  removeRoute: settledProcedure
    .input(z.object({ routeId: z.string() }))
    .mutation(async ({ input }) => {
      const route = await db.projectRoute.findUnique({ where: { id: input.routeId } })
      if (!route) throw new TRPCError({ code: 'NOT_FOUND', message: 'Route not found' })
      if (route.protected) throw new TRPCError({ code: 'FORBIDDEN', message: 'This route cannot be removed' })
      await db.projectRoute.delete({ where: { id: input.routeId } })
      return { ok: true }
    }),

  // ── Webhook ────────────────────────────────────────────────────────────────

  rotateWebhookSecret: settledProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const secret = generateWebhookSecret()
      await db.project.update({ where: { id: input.id }, data: { webhookSecret: secret } })
      return { webhookSecret: secret }
    }),

  getWebhookInfo: settledProcedure
    .input(z.object({ id: z.string(), domainId: z.string().optional() }))
    .query(async ({ input }) => {
      const project = await db.project.findUniqueOrThrow({
        where: { id: input.id },
        select: { webhookSecret: true, githubMode: true },
      })
      const domains = await db.domain.findMany({
        select: { id: true, hostname: true },
        orderBy: { createdAt: 'asc' },
      })
      const webhookDomains = domains.filter((d: { id: string; hostname: string }) => !isWildcardDomain(d.hostname))
      const chosen = input.domainId
        ? webhookDomains.find((d: { id: string; hostname: string }) => d.id === input.domainId)
        : webhookDomains.length === 1 ? webhookDomains[0] : null
      const baseUrl = chosen
        ? `https://${chosen.hostname}`
        : `http://localhost:3001`
      return {
        webhookUrl: `${baseUrl}/webhook/github/${input.id}`,
        webhookSecret: project.webhookSecret,
        githubMode: project.githubMode,
        domains: webhookDomains,
      }
    }),
})
