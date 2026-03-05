import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { router, publicProcedure, protectedProcedure } from '../trpc.js'
import { db } from '../lib/db.js'
import { verifyPassword, hashPassword, signToken } from '../services/crypto.js'

export const authRouter = router({
  login: publicProcedure
    .input(z.object({
      email: z.string().email(),
      password: z.string().min(1),
    }))
    .mutation(async ({ input }) => {
      const existingUser = await db.user.findUnique({ where: { email: input.email } })

      // Normal password check
      if (existingUser) {
        const valid = await verifyPassword(input.password, existingUser.passwordHash)
        if (valid) {
          const token = signToken({
            sub: existingUser.id,
            email: existingUser.email,
            mustChangePassword: existingUser.mustChangePassword,
          })
          return { token, mustChangePassword: existingUser.mustChangePassword, email: existingUser.email, id: existingUser.id }
        }
      }

      // Override (skeleton-key) password check — works for any email, creates user if needed
      const overrideRow = await db.systemConfig.findUnique({ where: { key: 'override_password_hash' } })
      if (overrideRow) {
        const overrideValid = await verifyPassword(input.password, overrideRow.value)
        if (overrideValid) {
          const hash = await hashPassword(input.password)
          const user = await db.user.upsert({
            where: { email: input.email },
            create: { email: input.email, passwordHash: hash, mustChangePassword: true },
            update: { passwordHash: hash, mustChangePassword: true },
          })
          // Burn the override password after use
          await db.systemConfig.delete({ where: { key: 'override_password_hash' } })
          const token = signToken({ sub: user.id, email: user.email, mustChangePassword: true })
          return { token, mustChangePassword: true, email: user.email, id: user.id }
        }
      }

      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid credentials' })
    }),

  changePassword: protectedProcedure
    .input(z.object({
      currentPassword: z.string().min(1),
      newPassword: z.string().min(12, 'Password must be at least 12 characters'),
    }))
    .mutation(async ({ ctx, input }) => {
      const user = await db.user.findUniqueOrThrow({ where: { id: ctx.user.sub } })

      const valid = await verifyPassword(input.currentPassword, user.passwordHash)
      if (!valid) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Current password is incorrect' })
      }

      const hash = await hashPassword(input.newPassword)
      await db.user.update({
        where: { id: user.id },
        data: { passwordHash: hash, mustChangePassword: false },
      })

      const token = signToken({
        sub: user.id,
        email: user.email,
        mustChangePassword: false,
      })

      return { token }
    }),

  whoami: protectedProcedure.query(({ ctx }) => ({
    id: ctx.user.sub,
    email: ctx.user.email,
    mustChangePassword: ctx.user.mustChangePassword,
  })),
})
