import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { router, settledProcedure } from '../trpc.js'
import { db } from '../lib/db.js'

// GitHub App credentials are stored in SystemConfig with these keys:
const KEYS = {
  APP_ID: 'github_app_id',
  PRIVATE_KEY: 'github_app_private_key',
  WEBHOOK_SECRET: 'github_app_webhook_secret',
} as const

async function getConfig(key: string) {
  const row = await db.systemConfig.findUnique({ where: { key } })
  return row?.value ?? null
}

async function setConfig(key: string, value: string) {
  return db.systemConfig.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  })
}

export const githubRouter = router({
  /** Returns the GitHub App manifest form data for one-click app creation */
  getManifest: settledProcedure
    .input(z.object({ domainId: z.string().optional() }))
    .query(async ({ input }) => {
      const domains = await db.domain.findMany({
        select: { id: true, hostname: true },
        orderBy: { createdAt: 'asc' },
      })
      const chosen = input.domainId
        ? domains.find((d: { id: string; hostname: string }) => d.id === input.domainId)
        : domains.length === 1 ? domains[0] : null
      const siteUrl = chosen
        ? `https://${chosen.hostname}`
        : (process.env.SITEY_URL ?? 'http://localhost:3001').replace(/\/$/, '')
      const hostname = (() => { try { return new URL(siteUrl).hostname } catch { return 'sitey' } })()
      const name = `sitey-${hostname}`.slice(0, 34)
      const manifest = {
        name,
        url: siteUrl,
        hook_attributes: { url: `${siteUrl}/webhook/github`, active: true },
        redirect_url: `${siteUrl}/github/app/callback`,
        default_permissions: { contents: 'read' },
        default_events: ['push'],
        public: false,
      }
      return {
        actionUrl: 'https://github.com/settings/apps/new',
        manifest: JSON.stringify(manifest),
        domains,
      }
    }),

  /** Exchanges the GitHub manifest code for full app credentials and stores them */
  exchangeManifestCode: settledProcedure
    .input(z.object({ code: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const res = await fetch(
        `https://api.github.com/app-manifests/${input.code}/conversions`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        },
      )
      if (!res.ok) {
        const text = await res.text()
        throw new TRPCError({ code: 'BAD_REQUEST', message: `GitHub API error: ${text}` })
      }
      const data = await res.json() as { id: number; pem: string; webhook_secret: string }
      await setConfig(KEYS.APP_ID, String(data.id))
      await setConfig(KEYS.PRIVATE_KEY, data.pem)
      await setConfig(KEYS.WEBHOOK_SECRET, data.webhook_secret)
      return { ok: true, appId: String(data.id) }
    }),

  getAppConfig: settledProcedure.query(async () => {
    const appId = await getConfig(KEYS.APP_ID)
    const hasPrivateKey = !!(await getConfig(KEYS.PRIVATE_KEY))
    const hasWebhookSecret = !!(await getConfig(KEYS.WEBHOOK_SECRET))
    return { appId, hasPrivateKey, hasWebhookSecret, configured: !!appId && hasPrivateKey }
  }),

  setAppConfig: settledProcedure
    .input(z.object({
      appId: z.string().min(1),
      privateKey: z.string().min(1),
      webhookSecret: z.string().min(1),
    }))
    .mutation(async ({ input }) => {
      await setConfig(KEYS.APP_ID, input.appId)
      await setConfig(KEYS.PRIVATE_KEY, input.privateKey)
      await setConfig(KEYS.WEBHOOK_SECRET, input.webhookSecret)
      return { ok: true }
    }),

  clearAppConfig: settledProcedure.mutation(async () => {
    await db.systemConfig.deleteMany({
      where: { key: { in: Object.values(KEYS) } },
    })
    return { ok: true }
  }),

  /** Set per-project GitHub App installation ID */
  setInstallation: settledProcedure
    .input(z.object({
      projectId: z.string(),
      installationId: z.string(),
    }))
    .mutation(({ input }) =>
      db.project.update({
        where: { id: input.projectId },
        data: { githubInstallationId: input.installationId, githubMode: 'app' },
      }),
    ),

  /** Returns webhook info for manual GitHub webhook setup */
  getWebhookInfo: settledProcedure
    .input(z.object({ projectId: z.string(), domainId: z.string().optional() }))
    .query(async ({ input }) => {
      const project = await db.project.findUniqueOrThrow({
        where: { id: input.projectId },
        select: { webhookSecret: true },
      })
      const domains = await db.domain.findMany({
        select: { id: true, hostname: true },
        orderBy: { createdAt: 'asc' },
      })
      const chosen = input.domainId
        ? domains.find((d: { id: string; hostname: string }) => d.id === input.domainId)
        : domains.length === 1 ? domains[0] : null
      const baseUrl = chosen
        ? `https://${chosen.hostname}`
        : (process.env.SITEY_URL ?? 'http://localhost:3001').replace(/\/$/, '')
      return {
        webhookUrl: `${baseUrl}/webhook/github/${input.projectId}`,
        webhookSecret: project.webhookSecret,
        contentType: 'application/json',
        events: ['push'],
        domains,
      }
    }),
})
