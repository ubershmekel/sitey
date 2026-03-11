import Fastify from 'fastify'
import cors from '@fastify/cors'
import { Readable } from 'node:stream'
import { fastifyTRPCPlugin, FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify'
import { appRouter, type AppRouter } from './routers/index.js'
import { createContext } from './context.js'
import { bootstrap } from './services/bootstrap.js'
import { verifyWebhookSignature } from './services/crypto.js'
import { db } from './lib/db.js'
import { enqueueDeployment } from './services/deployment.js'
import { reloadCaddy } from './services/caddy.js'
import { execSync } from 'node:child_process'

const PORT = parseInt(process.env.PORT ?? '3001')
const HOST = '0.0.0.0'

// Run Prisma migrations before starting (production only — dev uses db:push)
function runMigrations() {
  if (process.env.NODE_ENV !== 'production') return
  try {
    console.log('[startup] Running database migrations...')
    // shell:true needed on Windows so npm.cmd is resolved via the shell
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execSync('npm run db:migrate', { stdio: 'inherit', cwd: process.cwd(), shell: true, env: process.env } as any)
    console.log('[startup] Migrations complete.')
  } catch (err) {
    console.error('[startup] Migration failed:', err)
    process.exit(1)
  }
}

async function main() {
  runMigrations()
  await bootstrap()

  // Push initial Caddy config from DB state (non-fatal — Caddy may not be ready yet)
  reloadCaddy().catch(err => console.warn('[startup] Initial Caddy reload failed (will retry on next change):', err.message))

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
    trustProxy: true,
  })

  // Capture raw body for webhook routes (replaces @fastify/rawbody)
  app.addHook('preParsing', async (request, _reply, payload) => {
    if (!request.url.startsWith('/webhook/')) return payload
    const chunks: Buffer[] = []
    for await (const chunk of payload) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
    }
    const raw = Buffer.concat(chunks)
    ;(request as unknown as { rawBody: string }).rawBody = raw.toString('utf8')
    return Readable.from([raw])
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

  // ── GitHub App Webhook (no project ID — matched by repo + installation) ────
  app.post('/webhook/github', async (req, reply) => {
    const signature = (req.headers['x-hub-signature-256'] ?? '') as string
    const event = (req.headers['x-github-event'] ?? '') as string
    const rawBodyStr = (req as unknown as { rawBody: string }).rawBody ?? ''

    if (event !== 'push') {
      return reply.send({ ok: true, skipped: true, reason: `event=${event}` })
    }

    // Verify signature using the App-level webhook secret
    const secretRow = await db.systemConfig.findUnique({ where: { key: 'github_app_webhook_secret' } })
    const appSecret = secretRow?.value
    if (appSecret) {
      if (!signature || !verifyWebhookSignature(rawBodyStr, appSecret, signature)) {
        req.log.warn('GitHub App webhook signature verification failed')
        return reply.code(401).send({ error: 'Invalid signature' })
      }
    }

    let payload: {
      ref?: string
      installation?: { id?: number }
      repository?: { name?: string; owner?: { login?: string } }
      head_commit?: { id?: string; message?: string }
    }
    try {
      payload = JSON.parse(rawBodyStr)
    } catch {
      return reply.code(400).send({ error: 'Invalid JSON payload' })
    }

    const installationId = String(payload.installation?.id ?? '')
    const repoOwner = payload.repository?.owner?.login ?? ''
    const repoName = payload.repository?.name ?? ''
    const pushedRef = payload.ref ?? ''

    if (!repoOwner || !repoName) {
      return reply.send({ ok: true, skipped: true, reason: 'no repo info' })
    }

    // Find all app-mode projects matching this repo + installation
    // SQLite has no case-insensitive mode; lower() the stored values at query time
    const allAppProjects = await db.project.findMany({
      where: { githubMode: 'app', githubInstallationId: installationId },
    })
    const projects = allAppProjects.filter(
      p => p.repoOwner.toLowerCase() === repoOwner.toLowerCase()
        && p.repoName.toLowerCase() === repoName.toLowerCase(),
    )

    const commitSha = payload.head_commit?.id ?? undefined
    const commitMessage = payload.head_commit?.message ?? undefined
    const deploymentIds: string[] = []

    for (const project of projects) {
      const expectedRef = `refs/heads/${project.branch}`
      if (pushedRef !== expectedRef) continue

      const deployment = await db.deployment.create({
        data: { projectId: project.id, status: 'queued', commitSha, commitMessage, triggeredBy: 'webhook' },
      })
      enqueueDeployment(project, deployment)
      deploymentIds.push(deployment.id)
      req.log.info({ projectId: project.id, deploymentId: deployment.id }, 'GitHub App webhook deployment queued')
    }

    return reply.send({ ok: true, deploymentIds })
  })

  // ── GitHub Per-project Webhook ──────────────────────────────────────────────
  app.post<{ Params: { projectId: string } }>(
    '/webhook/github/:projectId',
    async (req, reply) => {
      const projectId = Number(req.params.projectId)
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
