import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import jwt from 'jsonwebtoken'
import { router, settledProcedure } from '../trpc.js'
import { db } from '../lib/db.js'

// GitHub App credentials are stored in SystemConfig with these keys:
const KEYS = {
  APP_ID: 'github_app_id',
  PRIVATE_KEY: 'github_app_private_key',
  WEBHOOK_SECRET: 'github_app_webhook_secret',
  APP_SLUG: 'github_app_slug',
} as const

const GITHUB_API_BASE = 'https://api.github.com'

function isWildcardDomain(hostname: string): boolean {
  return hostname.startsWith('*.')
}

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

function toPem(key: string) {
  return key.includes('\\n') ? key.replace(/\\n/g, '\n') : key
}

function createAppJwt(appId: string, privateKey: string) {
  const now = Math.floor(Date.now() / 1000)
  return jwt.sign(
    { iat: now - 60, exp: now + (9 * 60), iss: appId },
    toPem(privateKey),
    { algorithm: 'RS256' },
  )
}

async function githubFetch(path: string, init?: RequestInit) {
  return fetch(`${GITHUB_API_BASE}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init?.headers ?? {}),
    },
  })
}

function splitOwnerRepo(fullName: string) {
  const [owner, name] = fullName.split('/')
  return {
    owner: owner ?? '',
    name: name ?? '',
  }
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
      const manifestDomains = domains.filter((d: { id: string; hostname: string }) => !isWildcardDomain(d.hostname))
      const chosen = input.domainId
        ? manifestDomains.find((d: { id: string; hostname: string }) => d.id === input.domainId)
        : manifestDomains.length === 1 ? manifestDomains[0] : null
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
        domains: manifestDomains,
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
      const data = await res.json() as { id: number; slug?: string; pem: string; webhook_secret: string }
      await setConfig(KEYS.APP_ID, String(data.id))
      await setConfig(KEYS.PRIVATE_KEY, data.pem)
      await setConfig(KEYS.WEBHOOK_SECRET, data.webhook_secret)
      if (data.slug) await setConfig(KEYS.APP_SLUG, data.slug)
      return { ok: true, appId: String(data.id) }
    }),

  getAppConfig: settledProcedure.query(async () => {
    const appId = await getConfig(KEYS.APP_ID)
    const hasPrivateKey = !!(await getConfig(KEYS.PRIVATE_KEY))
    const hasWebhookSecret = !!(await getConfig(KEYS.WEBHOOK_SECRET))
    const appSlug = await getConfig(KEYS.APP_SLUG)
    const installUrl = appSlug ? `https://github.com/apps/${appSlug}/installations/new` : null
    return { appId, hasPrivateKey, hasWebhookSecret, configured: !!appId && hasPrivateKey, installUrl }
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
      try {
        const appJwt = createAppJwt(input.appId, input.privateKey)
        const appRes = await githubFetch('/app', { headers: { Authorization: `Bearer ${appJwt}` } })
        if (appRes.ok) {
          const appData = await appRes.json() as { slug?: string }
          if (appData.slug) await setConfig(KEYS.APP_SLUG, appData.slug)
        }
      } catch { /* best-effort */ }
      return { ok: true }
    }),

  clearAppConfig: settledProcedure.mutation(async () => {
    await db.systemConfig.deleteMany({
      where: { key: { in: Object.values(KEYS) as string[] } },
    })
    return { ok: true }
  }),

  listAppRepos: settledProcedure.query(async () => {
    const appId = await getConfig(KEYS.APP_ID)
    const privateKey = await getConfig(KEYS.PRIVATE_KEY)
    if (!appId || !privateKey) {
      return {
        configured: false,
        installations: 0,
        app: { slug: null as string | null, name: null as string | null, installUrl: null as string | null },
        repos: [],
      }
    }

    let appJwt = ''
    try {
      appJwt = createAppJwt(appId, privateKey)
    } catch {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid GitHub App private key.' })
    }

    let appSlug: string | null = null
    let appName: string | null = null
    try {
      const appRes = await githubFetch('/app', {
        headers: { Authorization: `Bearer ${appJwt}` },
      })
      if (appRes.ok) {
        const appData = await appRes.json() as { slug?: string; name?: string }
        appSlug = appData.slug ?? null
        appName = appData.name ?? null
      }
    } catch {
      // best-effort metadata; keep going
    }

    const installations: { id: number }[] = []
    for (let page = 1; ; page++) {
      const res = await githubFetch(`/app/installations?per_page=100&page=${page}`, {
        headers: { Authorization: `Bearer ${appJwt}` },
      })
      if (!res.ok) {
        const text = await res.text()
        throw new TRPCError({ code: 'BAD_REQUEST', message: `GitHub API error: ${text}` })
      }
      const rows = await res.json() as Array<{ id: number }>
      installations.push(...rows)
      if (rows.length < 100) break
    }

    const deduped = new Map<string, {
      id: number
      owner: string
      name: string
      fullName: string
      private: boolean
      defaultBranch: string | null
      installationId: string
    }>()

    for (const installation of installations) {
      const tokenRes = await githubFetch(`/app/installations/${installation.id}/access_tokens`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${appJwt}` },
      })
      if (!tokenRes.ok) {
        const text = await tokenRes.text()
        throw new TRPCError({ code: 'BAD_REQUEST', message: `GitHub API error: ${text}` })
      }
      const tokenData = await tokenRes.json() as { token: string }
      const accessToken = tokenData.token

      for (let page = 1; ; page++) {
        const reposRes = await githubFetch(`/installation/repositories?per_page=100&page=${page}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        })
        if (!reposRes.ok) {
          const text = await reposRes.text()
          throw new TRPCError({ code: 'BAD_REQUEST', message: `GitHub API error: ${text}` })
        }
        const payload = await reposRes.json() as {
          repositories: Array<{
            id: number
            full_name: string
            private: boolean
            default_branch: string | null
          }>
        }

        for (const repo of payload.repositories) {
          const parsed = splitOwnerRepo(repo.full_name)
          deduped.set(repo.full_name.toLowerCase(), {
            id: repo.id,
            owner: parsed.owner,
            name: parsed.name,
            fullName: repo.full_name,
            private: repo.private,
            defaultBranch: repo.default_branch,
            installationId: String(installation.id),
          })
        }
        if (payload.repositories.length < 100) break
      }
    }

    const repos = Array.from(deduped.values()).sort((a, b) => a.fullName.localeCompare(b.fullName))
    return {
      configured: true,
      installations: installations.length,
      app: {
        slug: appSlug,
        name: appName,
        installUrl: appSlug ? `https://github.com/apps/${appSlug}/installations/new` : null,
      },
      repos,
    }
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
      const webhookDomains = domains.filter((d: { id: string; hostname: string }) => !isWildcardDomain(d.hostname))
      const chosen = input.domainId
        ? webhookDomains.find((d: { id: string; hostname: string }) => d.id === input.domainId)
        : webhookDomains.length === 1 ? webhookDomains[0] : null
      const baseUrl = chosen
        ? `https://${chosen.hostname}`
        : (process.env.SITEY_URL ?? 'http://localhost:3001').replace(/\/$/, '')
      return {
        webhookUrl: `${baseUrl}/webhook/github/${input.projectId}`,
        webhookSecret: project.webhookSecret,
        contentType: 'application/json',
        events: ['push'],
        domains: webhookDomains,
      }
    }),
})
