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
import { docker, decodeDockerLogPayload } from '../services/docker.js'
import { db } from '../lib/db.js'

export const systemRouter = router({
  getPublicSiteUrl: settledProcedure.query(async () => resolvePublicSiteUrl()),

  getServerIp: settledProcedure.query(async () => {
    const row = await db.systemConfig.findUnique({ where: { key: 'server_ip' } })
    return { ip: row?.value ?? null }
  }),

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

  listContainers: settledProcedure.query(async () => {
    const containers = await docker.listContainers({ all: true })
    return containers.map((c) => ({
      id: c.Id.slice(0, 12),
      fullId: c.Id,
      name: (c.Names[0] ?? c.Id.slice(0, 12)).replace(/^\//, ''),
      image: c.Image,
      state: c.State,   // running | exited | paused | ...
      status: c.Status, // human-readable, e.g. "Up 2 hours"
    }))
  }),

  getContainerLogs: settledProcedure
    .input(z.object({
      containerId: z.string().min(1),
      tail: z.number().int().min(1).max(2000).default(300),
    }))
    .query(async ({ input }) => {
      try {
        const logs = await docker.getContainer(input.containerId).logs({
          stdout: true,
          stderr: true,
          timestamps: false,
          tail: input.tail,
        })
        const raw = decodeDockerLogPayload(logs)
        const lines = raw
          .split(/\r?\n/)
          .map((l) => l.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trimEnd())
          .filter(Boolean)
        return { lines }
      } catch {
        return { lines: ['Could not fetch container logs.'] }
      }
    }),
})

