import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, settledProcedure } from "../trpc.ts";
import { db } from "../lib/db.ts";
import { enqueueDeployment } from "../services/deployment.ts";
import { deployQueue } from "../lib/queue.ts";
import fs from "node:fs";

export const deployRouter = router({
  trigger: settledProcedure
    .input(
      z.object({
        serviceId: z.number().int(),
        commitSha: z.string().optional(),
        commitMessage: z.string().optional(),
        triggeredBy: z.enum(["manual", "hook"]).default("manual"),
      }),
    )
    .mutation(async ({ input }) => {
      const service = await db.service.findUnique({
        where: { id: input.serviceId },
      });
      if (!service)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Service not found",
        });
      if (!service.active)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot deploy an inactive service. Activate it first.",
        });

      const deployment = await db.deployment.create({
        data: {
          serviceId: input.serviceId,
          status: "queued",
          commitSha: input.commitSha ?? null,
          commitMessage: input.commitMessage ?? null,
          triggeredBy: input.triggeredBy,
        },
      });

      enqueueDeployment(service, deployment);

      return { deploymentId: deployment.id, status: "queued" };
    }),

  list: settledProcedure
    .input(
      z.object({
        serviceId: z.number().int(),
        limit: z.number().int().min(1).max(100).default(20),
      }),
    )
    .query(({ input }) =>
      db.deployment.findMany({
        where: { serviceId: input.serviceId },
        orderBy: { createdAt: "desc" },
        take: input.limit,
      }),
    ),

  get: settledProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const d = await db.deployment.findUnique({ where: { id: input.id } });
      if (!d)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Deployment not found",
        });
      return d;
    }),

  getLogs: settledProcedure
    .input(
      z.object({
        deploymentId: z.string(),
        tail: z.number().int().min(1).max(1000).default(200),
      }),
    )
    .query(async ({ input }) => {
      const deployment = await db.deployment.findUnique({
        where: { id: input.deploymentId },
      });
      if (!deployment)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Deployment not found",
        });

      if (!deployment.logPath) return { lines: [], status: deployment.status };

      try {
        const content = fs.readFileSync(deployment.logPath, "utf8");
        const lines = content.split("\n");
        const tail = lines.slice(-input.tail).filter(Boolean);
        return { lines: tail, status: deployment.status };
      } catch {
        return { lines: ["[log file not found]"], status: deployment.status };
      }
    }),

  queueStatus: settledProcedure
    .input(z.object({ serviceId: z.number().int() }))
    .query(({ input }) => ({
      isRunning: deployQueue.isRunning(input.serviceId),
      queued: deployQueue.queuedFor(input.serviceId),
    })),
});
