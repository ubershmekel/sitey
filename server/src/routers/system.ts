import { statfs, readFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, settledProcedure } from "../trpc.ts";
import {
  clearConfiguredPublicSiteUrl,
  isLoopbackHost,
  normalizeSiteUrl,
  resolvePublicSiteUrl,
  setConfiguredPublicSiteUrl,
} from "../services/siteUrl.ts";
import { docker, decodeDockerLogPayload } from "../services/docker.ts";
import { db } from "../lib/db.ts";

// ── Updater state ─────────────────────────────────────────────────────────────
// The update script tees output to /data/.update.log so logs survive the
// sitey-api restart that happens at the end of an update. On startup and in
// getUpdateStatus we read from that file as a fallback.

const DATA_ROOT = process.env.DATA_ROOT ?? "/data";
const UPDATE_LOG_PATH = `${DATA_ROOT}/.update.log`;

const updateState = {
  running: false,
  log: [] as string[],
  startedAt: null as string | null,
  finishedAt: null as string | null,
  exitCode: null as number | null,
};

/** Read the log file left by update-docker.sh (survives restarts). */
async function readUpdateLog(): Promise<string[]> {
  try {
    const content = await readFile(UPDATE_LOG_PATH, "utf8");
    return content.split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

// ── Version info ─────────────────────────────────────────────────────────────
// Cached per process lifetime (clears on restart, which happens every update).
type VersionInfo = { hash: string | null; timestamp: string | null };
let cachedVersion: VersionInfo | null = null;

async function fetchVersionFromUpdater(): Promise<VersionInfo> {
  const containers = await docker.listContainers({ all: true });
  const updater = containers.find((c) =>
    c.Names.some((n) => n.replace(/^\//, "").startsWith("sitey-sitey-updater")),
  );
  if (!updater || updater.State !== "running") {
    return { hash: null, timestamp: null };
  }
  const container = docker.getContainer(updater.Id);
  const exec = await container.exec({
    Cmd: [
      "sh",
      "-c",
      "cd /sitey-root && git rev-parse --short HEAD && git log -1 --format=%cI",
    ],
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ hijack: true });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  (
    docker.modem as {
      demuxStream: (s: unknown, o: unknown, e: unknown) => void;
    }
  ).demuxStream(stream, stdout, stderr);

  const chunks: Buffer[] = [];
  stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  await new Promise<void>((resolve) => {
    stream.on("end", resolve);
    stream.on("error", resolve);
  });

  const output = Buffer.concat(chunks).toString("utf8").trim();
  const [hash, timestamp] = output.split(/\r?\n/);
  return { hash: hash || null, timestamp: timestamp || null };
}

async function runUpdate(containerId: string): Promise<void> {
  try {
    const container = docker.getContainer(containerId);
    const exec = await container.exec({
      // Read the update script BEFORE git pull so we reference our own
      // generation's filename. After pull the file may have been renamed,
      // but we already have its contents in $S and eval it from memory.
      Cmd: [
        "sh",
        "-c",
        'UPDATE_SCRIPT=$(cat /sitey-root/deploy/updater/update-docker.sh) && cd /sitey-root && git pull && eval "$UPDATE_SCRIPT"',
      ],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({ hijack: true });

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    (
      docker.modem as {
        demuxStream: (s: unknown, o: unknown, e: unknown) => void;
      }
    ).demuxStream(stream, stdout, stderr);

    for (const s of [stdout, stderr]) {
      s.on("data", (chunk: Buffer) => {
        const lines = chunk.toString("utf8").split(/\r?\n/).filter(Boolean);
        updateState.log.push(...lines);
      });
    }

    // Note: sitey-api will likely be killed by docker compose up -d before
    // this promise resolves. The log file written by update-docker.sh is the
    // durable record; the in-memory state below is best-effort.
    await new Promise<void>((resolve) => {
      stream.on("end", resolve);
      stream.on("error", resolve);
    });

    try {
      const info = await exec.inspect();
      updateState.exitCode = (info as { ExitCode?: number }).ExitCode ?? 0;
    } catch {
      updateState.exitCode = 0;
    }
  } catch (err) {
    updateState.log.push(`ERROR: ${(err as Error).message}`);
    updateState.exitCode = 1;
  } finally {
    updateState.running = false;
    updateState.finishedAt = new Date().toISOString();
  }
}

export const systemRouter = router({
  getVersion: settledProcedure.query(async () => {
    if (cachedVersion) return cachedVersion;
    try {
      // Dev: local git. Prod: docker exec into the updater (which has /sitey-root).
      if (process.env.NODE_ENV !== "production") {
        const hash = execSync("git rev-parse --short HEAD", {
          encoding: "utf8",
        }).trim();
        const timestamp = execSync("git log -1 --format=%cI", {
          encoding: "utf8",
        }).trim();
        cachedVersion = { hash, timestamp };
      } else {
        cachedVersion = await fetchVersionFromUpdater();
      }
    } catch {
      cachedVersion = { hash: null, timestamp: null };
    }
    return cachedVersion;
  }),

  getPublicSiteUrl: settledProcedure.query(async () => resolvePublicSiteUrl()),

  getServerIp: settledProcedure.query(async () => {
    const row = await db.systemConfig.findUnique({
      where: { key: "server_ip" },
    });
    return { ip: row?.value ?? null };
  }),

  setPublicSiteUrl: settledProcedure
    .input(z.object({ url: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const normalized = normalizeSiteUrl(input.url);
      if (!normalized) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Invalid URL. Use a full public URL like https://sitey.example.com",
        });
      }
      if (isLoopbackHost(new URL(normalized).hostname)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Loopback URLs are not allowed here. Use a publicly reachable hostname.",
        });
      }
      await setConfiguredPublicSiteUrl(normalized);
      return { ok: true, url: normalized };
    }),

  clearPublicSiteUrl: settledProcedure.mutation(async () => {
    await clearConfiguredPublicSiteUrl();
    return { ok: true };
  }),

  listContainers: settledProcedure.query(async () => {
    const containers = await docker.listContainers({ all: true });
    return containers.map((c) => ({
      id: c.Id.slice(0, 12),
      fullId: c.Id,
      name: (c.Names[0] ?? c.Id.slice(0, 12)).replace(/^\//, ""),
      image: c.Image,
      state: c.State, // running | exited | paused | ...
      status: c.Status, // human-readable, e.g. "Up 2 hours"
    }));
  }),

  getDiskUsage: settledProcedure.query(async () => {
    const df = await docker.df();
    let images = 0,
      containers = 0,
      volumes = 0,
      buildCache = 0;
    for (const img of df.Images ?? [])
      images += (img as unknown as { Size?: number }).Size ?? 0;
    for (const c of df.Containers ?? []) containers += c.SizeRw ?? 0;
    for (const v of df.Volumes ?? []) volumes += v.UsageData?.Size ?? 0;
    for (const b of df.BuildCache ?? []) buildCache += b.Size ?? 0;
    const dataPath = process.env.DATA_ROOT ?? "/data";
    let stat, diskPath: string;
    try {
      stat = await statfs(dataPath);
      diskPath = dataPath;
    } catch {
      stat = await statfs("/");
      diskPath = "/";
    }
    const diskTotal = stat.blocks * stat.bsize;
    const diskAvailable = stat.bavail * stat.bsize;
    return {
      images,
      containers,
      volumes,
      buildCache,
      diskTotal,
      diskAvailable,
      diskPath,
    };
  }),

  triggerUpdate: settledProcedure.mutation(async () => {
    if (updateState.running) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "Update already in progress.",
      });
    }
    const containers = await docker.listContainers({ all: true });
    const updaterContainer = containers.find((c) =>
      c.Names.some((n) =>
        n.replace(/^\//, "").startsWith("sitey-sitey-updater"),
      ),
    );
    if (!updaterContainer) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "sitey-updater container not found. Is it running?",
      });
    }
    if (updaterContainer.State !== "running") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "sitey-updater container is not running.",
      });
    }
    updateState.running = true;
    updateState.log = [];
    updateState.startedAt = new Date().toISOString();
    updateState.finishedAt = null;
    updateState.exitCode = null;
    void runUpdate(updaterContainer.Id);
    return { started: true };
  }),

  getUpdateStatus: settledProcedure.query(async () => {
    // If we have in-memory state (update in progress or just finished), use it.
    // Otherwise fall back to the log file on disk, which survives restarts.
    // We infer success/failure from the log content since the in-memory state
    // is lost when sitey-api is restarted by the update itself.
    if (updateState.log.length > 0) {
      return {
        running: updateState.running,
        log: [...updateState.log],
        startedAt: updateState.startedAt,
        finishedAt: updateState.finishedAt,
        exitCode: updateState.exitCode,
      };
    }
    const log = await readUpdateLog();
    const lastLine = log[log.length - 1] ?? "";
    const completed = lastLine.includes("=== update complete ===");
    return {
      running: false,
      log,
      startedAt: null,
      finishedAt: completed ? "recovered" : null,
      exitCode: completed ? 0 : log.length > 0 ? 1 : null,
    };
  }),

  getContainerLogs: settledProcedure
    .input(
      z.object({
        containerId: z.string().min(1),
        tail: z.number().int().min(1).max(2000).default(300),
      }),
    )
    .query(async ({ input }) => {
      try {
        const logs = await docker.getContainer(input.containerId).logs({
          stdout: true,
          stderr: true,
          timestamps: false,
          tail: input.tail,
        });
        const raw = decodeDockerLogPayload(logs);
        const lines = raw
          .split(/\r?\n/)
          .map((l) =>
            l
              .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
              .trimEnd(),
          )
          .filter(Boolean);
        return { lines };
      } catch {
        return { lines: ["Could not fetch container logs."] };
      }
    }),
});
