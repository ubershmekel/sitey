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
      const user = await db.user.findUnique({ where: { email: input.email } })
      if (!user) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid credentials' })
      }

      const valid = await verifyPassword(input.password, user.passwordHash)
      if (!valid) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid credentials' })
      }

      const token = signToken({
        sub: user.id,
        email: user.email,
        mustChangePassword: user.mustChangePassword,
      })

      return {
        token,
        mustChangePassword: user.mustChangePassword,
        email: user.email,
        id: user.id,
      }
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
