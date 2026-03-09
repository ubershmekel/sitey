import { resolve4 } from 'node:dns/promises'
import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { router, settledProcedure } from '../trpc.js'
import { db } from '../lib/db.js'
import { reloadCaddy, getWildcardStatusProbeHostname, buildCaddyfile, scheduleDomainStatusRefresh, isDomainStatusStale } from '../services/caddy.js'

const HOSTNAME_REGEX =
  /^(?:\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/

function normalizeHostnameInput(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, '')
}

export const domainsRouter = router({
  list: settledProcedure.query(async () => {
    const domains = await db.domain.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { routes: true } },
      },
    })

    // Trigger background TLS probes for stale domains — does not block response
    for (const d of domains) {
      if (isDomainStatusStale(d.statusCheckedAt)) scheduleDomainStatusRefresh(d)
    }

    return domains.map(d => ({
      ...d,
      letsEncryptStatus: d.status,
    }))
  }),

  get: settledProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const domain = await db.domain.findUnique({
        where: { id: input.id },
        include: {
          routes: {
            orderBy: { createdAt: 'desc' },
            include: {
              project: {
                include: {
                  deployments: { orderBy: { createdAt: 'desc' }, take: 1 },
                },
              },
            },
          },
        },
      })
      if (!domain) throw new TRPCError({ code: 'NOT_FOUND', message: 'Domain not found' })
      return domain
    }),

  create: settledProcedure
    .input(z.object({
      hostname: z.preprocess(
        value => typeof value === 'string' ? normalizeHostnameInput(value) : value,
        z.string().min(3).regex(HOSTNAME_REGEX, 'Must be a valid hostname (e.g. example.com or *.example.com)'),
      ),
      letsEncryptEmail: z.string().email(),
    }))
    .mutation(async ({ input }) => {
      const existing = await db.domain.findUnique({ where: { hostname: input.hostname } })
      if (existing) {
        throw new TRPCError({ code: 'CONFLICT', message: 'Domain already exists' })
      }
      const domain = await db.domain.create({ data: input })
      // Push updated Caddy config — provisions TLS cert for this domain immediately.
      // Caddy failure is non-fatal: the domain exists in the DB. Return a warning so the UI can surface it.
      const warning = await reloadCaddy().then(() => null, err => String(err))
      if (warning) console.error('[domains] Caddy reload failed after create:', warning)
      return { ...domain, warning }
    }),

  update: settledProcedure
    .input(z.object({
      id: z.string(),
      letsEncryptEmail: z.string().email().optional(),
      status: z.enum(['pending', 'active', 'error']).optional(),
    }))
    .mutation(async ({ input }) => {
      const { id, ...data } = input
      return db.domain.update({ where: { id }, data })
    }),

  delete: settledProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      await db.domain.delete({ where: { id: input.id } })
      // Push updated Caddy config — removes the domain block (cert will expire naturally)
      reloadCaddy().catch(err => console.error('[domains] Caddy reload failed:', err))
      return { ok: true }
    }),

  getCaddyfile: settledProcedure
    .query(() => buildCaddyfile()),

  checkDns: settledProcedure
    .input(z.object({ hostname: z.string().min(1) }))
    .query(async ({ input }) => {
      const hostname = input.hostname.trim().toLowerCase()
      const isWildcard = hostname.startsWith('*.')
      const checkedHostname = isWildcard ? (getWildcardStatusProbeHostname(hostname) ?? hostname) : hostname
      try {
        const addresses = await resolve4(checkedHostname)
        return { resolves: true, addresses, checkedHostname, wildcard: isWildcard }
      } catch {
        return { resolves: false, addresses: [] as string[], checkedHostname, wildcard: isWildcard }
      }
    }),
})
