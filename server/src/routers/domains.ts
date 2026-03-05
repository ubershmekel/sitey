import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { router, settledProcedure } from '../trpc.js'
import { db } from '../lib/db.js'

export const domainsRouter = router({
  list: settledProcedure.query(async () => {
    return db.domain.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { projects: true } },
      },
    })
  }),

  get: settledProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const domain = await db.domain.findUnique({
        where: { id: input.id },
        include: {
          projects: {
            orderBy: { createdAt: 'desc' },
            include: {
              deployments: {
                orderBy: { createdAt: 'desc' },
                take: 1,
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
      hostname: z.string().min(3).regex(
        /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/,
        'Must be a valid hostname (e.g. example.com)',
      ),
      letsEncryptEmail: z.string().email(),
    }))
    .mutation(async ({ input }) => {
      const existing = await db.domain.findUnique({ where: { hostname: input.hostname } })
      if (existing) {
        throw new TRPCError({ code: 'CONFLICT', message: 'Domain already exists' })
      }
      return db.domain.create({ data: input })
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
      return { ok: true }
    }),
})
