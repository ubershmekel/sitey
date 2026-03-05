import Fastify from 'fastify'
import cors from '@fastify/cors'
import rawBody from '@fastify/rawbody'
import { fastifyTRPCPlugin, FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify'
import { appRouter, type AppRouter } from './routers/index.js'
import { createContext } from './context.js'
import { bootstrap } from './services/bootstrap.js'
import { verifyWebhookSignature } from './services/crypto.js'
import { db } from './lib/db.js'
import { enqueueDeployment } from './services/deployment.js'
import { execSync } from 'node:child_process'

const PORT = parseInt(process.env.PORT ?? '3001')
const HOST = '0.0.0.0'

// Run Prisma migrations before starting
function runMigrations() {
  try {
    console.log('[startup] Running database migrations...')
    execSync('npx prisma migrate deploy', { stdio: 'inherit', cwd: process.cwd() })
    console.log('[startup] Migrations complete.')
  } catch (err) {
    console.error('[startup] Migration failed:', err)
    process.exit(1)
  }
}

async function main() {
  runMigrations()
  await bootstrap()

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
    trustProxy: true,
  })

  // Raw body for webhook signature verification
  await app.register(rawBody, {
    field: 'rawBody',
    global: false,
    encoding: 'utf8',
    runFirst: true,
    routes: ['/webhook/github/:projectId'],
  })

  await app.register(cors, {
    origin: true, // reflect request origin — no domain required at boot
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  })

  // ── tRPC ──────────────────────────────────────────────────────────────────
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext,
      onError: ({ path, error }) => {
        if (error.code !== 'UNAUTHORIZED' && error.code !== 'NOT_FOUND') {
          app.log.error({ path, error }, 'tRPC error')
        }
      },
    } satisfies FastifyTRPCPluginOptions<AppRouter>['trpcOptions'],
  })

  // ── Health ─────────────────────────────────────────────────────────────────
  app.get('/health', async () => ({ ok: true, version: '0.1.0' }))

  // ── GitHub Webhook ─────────────────────────────────────────────────────────
  app.post<{ Params: { projectId: string } }>(
    '/webhook/github/:projectId',
    {
      config: { rawBody: true },
    },
    async (req, reply) => {
      const { projectId } = req.params
      const signature = (req.headers['x-hub-signature-256'] ?? '') as string
      const event = (req.headers['x-github-event'] ?? '') as string
      const rawBodyStr = (req as unknown as { rawBody: string }).rawBody ?? ''

      // Load project
      const project = await db.project.findUnique({ where: { id: projectId } })
      if (!project) {
        return reply.code(404).send({ error: 'Project not found' })
      }

      // Verify signature
      const secret = project.webhookSecret
      if (secret) {
        if (!signature || !verifyWebhookSignature(rawBodyStr, secret, signature)) {
          req.log.warn({ projectId }, 'Webhook signature verification failed')
          return reply.code(401).send({ error: 'Invalid signature' })
        }
      }

      // Only act on push events
      if (event !== 'push') {
        return reply.send({ ok: true, skipped: true, reason: `event=${event}` })
      }

      // Parse payload
      let payload: { ref?: string; head_commit?: { id?: string; message?: string } }
      try {
        payload = JSON.parse(rawBodyStr)
      } catch {
        return reply.code(400).send({ error: 'Invalid JSON payload' })
      }

      // Check branch
      const pushedRef = payload.ref ?? ''
      const expectedRef = `refs/heads/${project.branch}`
      if (pushedRef !== expectedRef) {
        return reply.send({ ok: true, skipped: true, reason: `ref=${pushedRef} not tracked` })
      }

      // Create deployment record and enqueue
      const commitSha = payload.head_commit?.id ?? undefined
      const commitMessage = payload.head_commit?.message ?? undefined

      const deployment = await db.deployment.create({
        data: {
          projectId,
          status: 'queued',
          commitSha,
          commitMessage,
          triggeredBy: 'webhook',
        },
      })

      enqueueDeployment(project, deployment)
      req.log.info({ projectId, deploymentId: deployment.id }, 'Webhook deployment queued')

      return reply.send({ ok: true, deploymentId: deployment.id })
    },
  )

  await app.listen({ port: PORT, host: HOST })
  console.log(`[server] Listening on ${HOST}:${PORT}`)
}

main().catch(err => {
  console.error('[server] Fatal error:', err)
  process.exit(1)
})
