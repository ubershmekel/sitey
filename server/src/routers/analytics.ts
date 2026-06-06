/**
 * Read-only analytics router. Reads `analytics.db` directly (better-sqlite3).
 *
 * - `forService` returns the cheap headline counters (all-time + last 7 days)
 *   from the `total`/`daily` rollups — survives `request` pruning, returns all
 *   zeros for a service with no traffic yet.
 * - `detail` powers the analytics page, queried straight off the `request`
 *   table (top paths, top errors). No rollup tables or caches — the page is
 *   opened occasionally and a GROUP BY over the `(service_id, ts)` index is
 *   milliseconds even on a busy instance.
 *
 * See docs/design/analytics.md.
 */

import { z } from "zod";
import { router, settledProcedure } from "../trpc.ts";
import { getAnalyticsDb } from "../lib/analyticsDb.ts";
import { utcDayNumber } from "../services/analytics/time.ts";

type CounterRow = { requests: number; errors: number; bytes: number };

export const analyticsRouter = router({
  forService: settledProcedure
    .input(z.object({ serviceId: z.number().int() }))
    .query(({ input }) => {
      const db = getAnalyticsDb();

      const total = db
        .prepare(
          "SELECT requests, errors, bytes FROM total WHERE service_id = ?",
        )
        .get(input.serviceId) as CounterRow | undefined;

      const now = Math.floor(Date.now() / 1000);
      const sinceDay = utcDayNumber(now - 7 * 86400);
      const last7d = db
        .prepare(
          `SELECT
             COALESCE(SUM(requests), 0) AS requests,
             COALESCE(SUM(errors), 0)   AS errors,
             COALESCE(SUM(bytes), 0)    AS bytes
           FROM daily WHERE service_id = ? AND day >= ?`,
        )
        .get(input.serviceId, sinceDay) as CounterRow;

      return {
        totalRequests: total?.requests ?? 0,
        last7dRequests: last7d.requests,
        last7dErrors: last7d.errors,
        last7dBytes: last7d.bytes,
      };
    }),

  detail: settledProcedure
    .input(
      z.object({
        serviceId: z.number().int(),
        days: z.number().int().min(1).max(90).default(7),
        // Optional status filter: an exact code (e.g. 404) or a floor handled
        // client-side. Here a bare number means "exactly this status".
        status: z.number().int().optional(),
      }),
    )
    .query(({ input }) => {
      const db = getAnalyticsDb();
      const since = Math.floor(Date.now() / 1000) - input.days * 86400;

      const topPaths = db
        .prepare(
          `SELECT path, count(*) AS count
             FROM request
            WHERE service_id = ? AND ts >= ?
            GROUP BY path
            ORDER BY count DESC
            LIMIT 20`,
        )
        .all(input.serviceId, since) as Array<{ path: string; count: number }>;

      const topErrors = (
        input.status !== undefined
          ? db
              .prepare(
                `SELECT path, status, count(*) AS count
                   FROM request
                  WHERE service_id = ? AND status = ? AND ts >= ?
                  GROUP BY path, status
                  ORDER BY count DESC
                  LIMIT 20`,
              )
              .all(input.serviceId, input.status, since)
          : db
              .prepare(
                `SELECT path, status, count(*) AS count
                   FROM request
                  WHERE service_id = ? AND status >= 400 AND ts >= ?
                  GROUP BY path, status
                  ORDER BY count DESC
                  LIMIT 20`,
              )
              .all(input.serviceId, since)
      ) as Array<{ path: string; status: number; count: number }>;

      return { topPaths, topErrors };
    }),
});
