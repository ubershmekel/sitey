import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { router, publicProcedure } from '../trpc.js'
import { db } from '../lib/db.js'
import { hashPassword, signToken } from '../services/crypto.js'

export const setupRouter = router({
  /** Returns whether initial setup has been completed. */
  status: publicProcedure.query(async () => {
    const row = await db.systemConfig.findUnique({ where: { key: 'setup_complete' } })
    return { setupComplete: row?.value === 'true' }
  }),

  /** One-time setup: creates the admin account and marks setup as complete. */
  complete: publicProcedure
    .input(z.object({
      email: z.string().email(),
      password: z.string().min(12, 'Password must be at least 12 characters'),
    }))
    .mutation(async ({ input }) => {
      const alreadyDone = await db.systemConfig.findUnique({ where: { key: 'setup_complete' } })
      if (alreadyDone?.value === 'true') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Setup already complete.' })
      }

      const existing = await db.user.count()
      if (existing > 0) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Setup already complete.' })
      }

      const hash = await hashPassword(input.password)
      const user = await db.user.create({
        data: {
          email: input.email,
          passwordHash: hash,
          mustChangePassword: false,
        },
      })

      await db.systemConfig.upsert({
        where: { key: 'setup_complete' },
        create: { key: 'setup_complete', value: 'true' },
        update: { value: 'true' },
      })

      const token = signToken({ sub: user.id, email: user.email, mustChangePassword: false })
      return { token }
    }),
})
