import { resolve4 } from "node:dns/promises";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, settledProcedure } from "../trpc.js";
import { db } from "../lib/db.js";
import {
  reloadCaddy,
  getWildcardStatusProbeHostname,
  buildCaddyfile,
  scheduleDomainStatusRefresh,
  isDomainStatusStale,
} from "../services/caddy.js";
import { docker } from "../services/docker.js";

const HOSTNAME_REGEX =
  /^(?:\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

function decodeDockerLogPayload(logs: unknown): string {
  if (!Buffer.isBuffer(logs)) return String(logs ?? "");

  let cursor = 0;
  const chunks: Buffer[] = [];

  // Docker multiplexed log format (stdout/stderr) uses 8-byte frame headers:
  // [stream:1][reserved:3][size:4 big-endian][payload:size]
  while (cursor + 8 <= logs.length) {
    const size = logs.readUInt32BE(cursor + 4);
    const start = cursor + 8;
    const end = start + size;
    if (end > logs.length) break;
    chunks.push(logs.subarray(start, end));
    cursor = end;
  }

  // If parsing produced nothing, fall back to plain UTF-8 decode.
  return (chunks.length ? Buffer.concat(chunks) : logs).toString("utf8");
}

function normalizeHostnameInput(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, "");
}

function normalizeOptionalEmail(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export const domainsRouter = router({
  list: settledProcedure.query(async () => {
    const domains = await db.domain.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        _count: { select: { routes: true } },
      },
    });

    // Trigger background TLS probes for stale domains — does not block response
    for (const d of domains) {
      if (isDomainStatusStale(d.statusCheckedAt))
        scheduleDomainStatusRefresh(d);
    }

    return domains.map((d) => ({
      ...d,
      letsEncryptStatus: d.status,
    }));
  }),

  get: settledProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ input }) => {
      const domain = await db.domain.findUnique({
        where: { id: input.id },
        include: {
          routes: {
            orderBy: { createdAt: "desc" },
            include: {
              project: {
                include: {
                  deployments: { orderBy: { createdAt: "desc" }, take: 1 },
                },
              },
            },
          },
        },
      });
      if (!domain)
        throw new TRPCError({ code: "NOT_FOUND", message: "Domain not found" });
      return domain;
    }),

  create: settledProcedure
    .input(
      z.object({
        hostname: z.preprocess(
          (value) =>
            typeof value === "string" ? normalizeHostnameInput(value) : value,
          z
            .string()
            .min(3)
            .regex(
              HOSTNAME_REGEX,
              "Must be a valid hostname (e.g. example.com or *.example.com)",
            ),
        ),
        letsEncryptEmail: z
          .preprocess(normalizeOptionalEmail, z.string())
          .optional()
          .default(""),
      }),
    )
    .mutation(async ({ input }) => {
      const existing = await db.domain.findUnique({
        where: { hostname: input.hostname },
      });
      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Domain already exists",
        });
      }
      const domain = await db.domain.create({
        data: {
          hostname: input.hostname,
          letsEncryptEmail: input.letsEncryptEmail,
        },
      });
      // Push updated Caddy config — provisions TLS cert for this domain immediately.
      // Caddy failure is non-fatal: the domain exists in the DB. Return a warning so the UI can surface it.
      const warning = await reloadCaddy().then(
        () => null,
        (err) => String(err),
      );
      if (warning)
        console.error("[domains] Caddy reload failed after create:", warning);
      return { ...domain, warning };
    }),

  update: settledProcedure
    .input(
      z.object({
        id: z.number().int(),
        letsEncryptEmail: z
          .preprocess(normalizeOptionalEmail, z.string())
          .optional(),
        status: z.enum(["pending", "active", "error"]).optional(),
        siteySubdomainsEnabled: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { id, ...data } = input;
      const domain = await db.domain.update({ where: { id }, data });
      if ("siteySubdomainsEnabled" in data) {
        reloadCaddy().catch((err) =>
          console.error("[domains] Caddy reload failed after update:", err),
        );
      }
      return domain;
    }),

  delete: settledProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ input }) => {
      await db.domain.delete({ where: { id: input.id } });
      // Push updated Caddy config — removes the domain block (cert will expire naturally)
      reloadCaddy().catch((err) =>
        console.error("[domains] Caddy reload failed:", err),
      );
      return { ok: true };
    }),

  getCaddyfile: settledProcedure.query(() => buildCaddyfile()),

  getCaddyLogs: settledProcedure
    .input(
      z.object({
        tail: z.number().int().min(1).max(1000).default(200),
      }),
    )
    .query(async ({ input }) => {
      const candidates = await docker.listContainers({
        all: true,
        filters: { label: ["com.docker.compose.service=caddy"] },
      });

      const selected =
        candidates.find((c) => c.State === "running") ?? candidates[0];
      if (!selected?.Id) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Caddy container not found",
        });
      }

      try {
        const logs = await docker.getContainer(selected.Id).logs({
          stdout: true,
          stderr: true,
          timestamps: false,
          tail: input.tail,
        });
        const raw = decodeDockerLogPayload(logs);
        const lines = raw
          .split(/\r?\n/)
          .map((line) =>
            line
              .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
              .trimEnd(),
          )
          .filter(Boolean);

        return {
          container: selected.Names?.[0]?.replace(/^\//, "") ?? "caddy",
          lines,
        };
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to read Caddy logs: ${(err as Error).message}`,
        });
      }
    }),

  checkDns: settledProcedure
    .input(z.object({ hostname: z.string().min(1) }))
    .query(async ({ input }) => {
      const hostname = input.hostname.trim().toLowerCase();
      const isWildcard = hostname.startsWith("*.");
      const checkedHostname = isWildcard
        ? (getWildcardStatusProbeHostname(hostname) ?? hostname)
        : hostname;
      try {
        const addresses = await resolve4(checkedHostname);
        return {
          resolves: true,
          addresses,
          checkedHostname,
          wildcard: isWildcard,
        };
      } catch {
        return {
          resolves: false,
          addresses: [] as string[],
          checkedHostname,
          wildcard: isWildcard,
        };
      }
    }),
});
