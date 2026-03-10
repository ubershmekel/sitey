import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { router, settledProcedure } from '../trpc.js'
import {
  clearConfiguredPublicSiteUrl,
  isLoopbackHost,
  normalizeSiteUrl,
  resolvePublicSiteUrl,
  setConfiguredPublicSiteUrl,
} from '../services/siteUrl.js'

export const systemRouter = router({
  getPublicSiteUrl: settledProcedure.query(async () => resolvePublicSiteUrl()),

  setPublicSiteUrl: settledProcedure
    .input(z.object({ url: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const normalized = normalizeSiteUrl(input.url)
      if (!normalized) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Invalid URL. Use a full public URL like https://sitey.example.com',
        })
      }
      if (isLoopbackHost(new URL(normalized).hostname)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Loopback URLs are not allowed here. Use a publicly reachable hostname.',
        })
      }
      await setConfiguredPublicSiteUrl(normalized)
      return { ok: true, url: normalized }
    }),

  clearPublicSiteUrl: settledProcedure.mutation(async () => {
    await clearConfiguredPublicSiteUrl()
    return { ok: true }
  }),
})

