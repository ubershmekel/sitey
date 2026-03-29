/**
 * Analytics service — parses Caddy JSON access logs from Docker stdout
 * and aggregates daily request counts into the DomainStats table.
 *
 * Call collectAnalytics() periodically (e.g. every 5 minutes).
 * Progress is tracked in SystemConfig under COLLECTION_CONFIG_KEY so each
 * run only processes new log lines since the last collection.
 */

import { db } from "../lib/db.ts";
import { docker, decodeDockerLogPayload } from "./docker.ts";

const COLLECTION_CONFIG_KEY = "analytics:lastCollectedAt";

type CaddyAccessEntry = {
  level: string;
  ts: number;
  logger: string;
  request?: {
    host?: string;
  };
  status?: number;
};

function isAccessLogEntry(entry: unknown): entry is CaddyAccessEntry {
  if (typeof entry !== "object" || entry === null) return false;
  const e = entry as Record<string, unknown>;
  return (
    typeof e.logger === "string" &&
    e.logger.startsWith("http.log.access") &&
    typeof e.ts === "number" &&
    typeof e.request === "object" &&
    e.request !== null &&
    typeof (e.request as Record<string, unknown>).host === "string"
  );
}

export async function collectAnalytics(): Promise<void> {
  const candidates = await docker.listContainers({
    all: false,
    filters: { label: ["com.docker.compose.service=caddy"] },
  });
  const caddyContainer = candidates.find((c) => c.State === "running");
  if (!caddyContainer?.Id) return;

  const lastConfig = await db.systemConfig.findUnique({
    where: { key: COLLECTION_CONFIG_KEY },
  });
  const sinceTs = lastConfig ? parseFloat(lastConfig.value) : 0;
  const nowTs = Math.floor(Date.now() / 1000);

  const logsBuffer = await docker
    .getContainer(caddyContainer.Id)
    .logs({ stdout: true, stderr: false, timestamps: false, since: sinceTs });

  const raw = decodeDockerLogPayload(logsBuffer);
  const lines = raw.split(/\r?\n/).filter(Boolean);

  // Aggregate: key = "hostname|YYYY-MM-DD"
  const counts = new Map<string, { requests: number; errors: number }>();

  for (const line of lines) {
    try {
      const entry: unknown = JSON.parse(line);
      if (!isAccessLogEntry(entry)) continue;
      const host = entry.request!.host!;
      if (!host) continue;
      const date = new Date(entry.ts * 1000).toISOString().slice(0, 10);
      const key = `${host}|${date}`;
      const current = counts.get(key) ?? { requests: 0, errors: 0 };
      current.requests++;
      if (typeof entry.status === "number" && entry.status >= 400)
        current.errors++;
      counts.set(key, current);
    } catch {
      // Not JSON or unexpected format — skip
    }
  }

  for (const [key, c] of counts) {
    const [hostname, date] = key.split("|") as [string, string];
    await db.domainStats.upsert({
      where: { hostname_date: { hostname, date } },
      create: {
        hostname,
        date,
        requestCount: c.requests,
        errorCount: c.errors,
      },
      update: {
        requestCount: { increment: c.requests },
        errorCount: { increment: c.errors },
      },
    });
  }

  await db.systemConfig.upsert({
    where: { key: COLLECTION_CONFIG_KEY },
    create: { key: COLLECTION_CONFIG_KEY, value: String(nowTs) },
    update: { value: String(nowTs) },
  });
}
