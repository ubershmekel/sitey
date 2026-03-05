import { z } from 'zod'
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
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input }) => {
      const project = await db.project.findUniqueOrThrow({
        where: { id: input.projectId },
        select: { webhookSecret: true },
      })
      const baseUrl = process.env.SITEY_URL ?? 'http://localhost:3001'
      return {
        webhookUrl: `${baseUrl}/webhook/github/${input.projectId}`,
        webhookSecret: project.webhookSecret,
        contentType: 'application/json',
        events: ['push'],
      }
    }),
})
