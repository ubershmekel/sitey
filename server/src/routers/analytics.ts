import { z } from "zod";
import { router, settledProcedure } from "../trpc.ts";
import { db } from "../lib/db.ts";
import { collectAnalytics } from "../services/analytics.ts";

export const analyticsRouter = router({
  getStats: settledProcedure
    .input(
      z.object({ days: z.number().int().min(1).max(90).default(30) }),
    )
    .query(async ({ input }) => {
      const since = new Date();
      since.setDate(since.getDate() - input.days + 1);
      const sinceDate = since.toISOString().slice(0, 10);

      const rows = await db.domainStats.findMany({
        where: { date: { gte: sinceDate } },
        orderBy: [{ date: "asc" }, { hostname: "asc" }],
      });

      return rows;
    }),

  refresh: settledProcedure.mutation(async () => {
    await collectAnalytics();
    return { ok: true };
  }),
});
