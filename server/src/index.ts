import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { Readable } from "node:stream";
import {
  fastifyTRPCPlugin,
  type FastifyTRPCPluginOptions,
} from "@trpc/server/adapters/fastify";
import { appRouter, type AppRouter } from "./routers/index.ts";
import { createContext } from "./context.ts";
import { bootstrap } from "./services/bootstrap.ts";
import { verifyWebhookSignature } from "./services/crypto.ts";
import { db } from "./lib/db.ts";
import { enqueueDeployment } from "./services/deployment.ts";
import { reloadCaddy } from "./services/caddy.ts";
import { getGithubIntegrationConfig } from "./services/github.ts";
import { execSync } from "node:child_process";

const PORT = parseInt(process.env.PORT ?? "3001");
const HOST = "0.0.0.0";

// Run Prisma migrations before starting (production only — dev uses db:push)
function runMigrations() {
  if (process.env.NODE_ENV !== "production") return;
  try {
    console.log("[startup] Running database migrations...");
    // shell:true needed on Windows so npm.cmd is resolved via the shell
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execSync("npm run db:migrate", {
      stdio: "inherit",
      cwd: process.cwd(),
      shell: true,
      env: process.env,
    } as any);
    console.log("[startup] Migrations complete.");
  } catch (err) {
    console.error("[startup] Migration failed:", err);
    process.exit(1);
  }
}

async function main() {
  runMigrations();
  await bootstrap();

  // Push initial Caddy config from DB state (non-fatal — Caddy may not be ready yet)
  reloadCaddy().catch((err) =>
    console.warn(
      "[startup] Initial Caddy reload failed (will retry on next change):",
      err.message,
    ),
  );

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
    },
    trustProxy: true,
    routerOptions: { maxParamLength: 500 },
  });

  // Capture raw body for webhook routes (replaces @fastify/rawbody)
  app.addHook("preParsing", async (request, _reply, payload) => {
    if (
      !request.url.startsWith("/webhook/") &&
      !request.url.startsWith("/hook/")
    )
      return payload;
    const chunks: Buffer[] = [];
    for await (const chunk of payload) {
      chunks.push(
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string),
      );
    }
    const raw = Buffer.concat(chunks);
    (request as unknown as { rawBody: string }).rawBody = raw.toString("utf8");
    return Readable.from([raw]);
  });

  await app.register(cookie);

  await app.register(cors, {
    origin: true, // reflect request origin — no domain required at boot
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
  });

  // ── tRPC ──────────────────────────────────────────────────────────────────
  await app.register(fastifyTRPCPlugin, {
    prefix: "/trpc",
    trpcOptions: {
      router: appRouter,
      createContext,
      onError: ({ path, error }) => {
        if (error.code !== "UNAUTHORIZED" && error.code !== "NOT_FOUND") {
          app.log.error({ path, error }, "tRPC error");
        }
      },
    } satisfies FastifyTRPCPluginOptions<AppRouter>["trpcOptions"],
  });

  // ── Health ─────────────────────────────────────────────────────────────────
  app.get("/health", async () => ({ ok: true, version: "0.1.0" }));

  // ── GitHub App Webhook (no service ID — matched by repo owner/name) ────
  app.post("/webhook/github", async (req, reply) => {
    const signature = (req.headers["x-hub-signature-256"] ?? "") as string;
    const event = (req.headers["x-github-event"] ?? "") as string;
    const rawBodyStr = (req as unknown as { rawBody: string }).rawBody ?? "";

    if (event !== "push") {
      return reply.send({ ok: true, skipped: true, reason: `event=${event}` });
    }

    // Verify signature using the App-level webhook secret (required — no secret = reject)
    const { webhookSecret: appSecret } = await getGithubIntegrationConfig();
    if (!appSecret) {
      req.log.warn(
        "GitHub App webhook received but no webhook secret configured — rejecting",
      );
      return reply.code(500).send({ error: "Webhook secret not configured" });
    }
    if (
      !signature ||
      !verifyWebhookSignature(rawBodyStr, appSecret, signature)
    ) {
      req.log.warn("GitHub App webhook signature verification failed");
      return reply.code(401).send({ error: "Invalid signature" });
    }

    let payload: {
      ref?: string;
      repository?: { name?: string; owner?: { login?: string } };
      head_commit?: { id?: string; message?: string };
    };
    try {
      payload = JSON.parse(rawBodyStr);
    } catch {
      return reply.code(400).send({ error: "Invalid JSON payload" });
    }

    const repoOwner = payload.repository?.owner?.login ?? "";
    const repoName = payload.repository?.name ?? "";
    const pushedRef = payload.ref ?? "";

    if (!repoOwner || !repoName) {
      return reply.send({ ok: true, skipped: true, reason: "no repo info" });
    }

    // Find all app-mode services whose repo matches the push event.
    const services = await db.service.findMany({
      where: {
        active: true,
        repo: {
          githubMode: "app",
        },
      },
      include: { repo: true },
    });
    const matched = services.filter(
      (s) =>
        s.repo.repoOwner.toLowerCase() === repoOwner.toLowerCase() &&
        s.repo.repoName.toLowerCase() === repoName.toLowerCase(),
    );
    req.log.info(
      { repoOwner, repoName, pushedRef, matchedServiceCount: matched.length },
      "GitHub App webhook: matched services",
    );

    const commitSha = payload.head_commit?.id ?? undefined;
    const commitMessage = payload.head_commit?.message ?? undefined;
    const deploymentIds: string[] = [];

    for (const service of matched) {
      const expectedRef = `refs/heads/${service.branch}`;
      if (pushedRef !== expectedRef) continue;

      const deployment = await db.deployment.create({
        data: {
          serviceId: service.id,
          status: "queued",
          commitSha,
          commitMessage,
          triggeredBy: "hook",
        },
      });
      enqueueDeployment(service, deployment);
      deploymentIds.push(deployment.id);
      req.log.info(
        { serviceId: service.id, deploymentId: deployment.id },
        "GitHub App webhook deployment queued",
      );
    }

    return reply.send({ ok: true, deploymentIds });
  });

  // ── Hook endpoint (opaque publicId — replaces per-service webhook) ──────
  app.post<{ Params: { publicId: string } }>(
    "/hook/:publicId",
    async (req, reply) => {
      const { publicId } = req.params;
      const signature = (req.headers["x-hub-signature-256"] ?? "") as string;
      const event = (req.headers["x-github-event"] ?? "") as string;
      const rawBodyStr = (req as unknown as { rawBody: string }).rawBody ?? "";

      // Look up the hook endpoint
      const endpoint = await db.hookEndpoint.findUnique({
        where: { publicId },
        include: {
          repo: { include: { services: true } },
        },
      });
      if (!endpoint) {
        return reply.code(404).send({ error: "Hook not found" });
      }

      // Verify signature
      if (endpoint.secret) {
        if (
          !signature ||
          !verifyWebhookSignature(rawBodyStr, endpoint.secret, signature)
        ) {
          req.log.warn({ publicId }, "Hook signature verification failed");
          return reply.code(401).send({ error: "Invalid signature" });
        }
      }

      // Only act on push events
      if (event !== "push") {
        return reply.send({
          ok: true,
          skipped: true,
          reason: `event=${event}`,
        });
      }

      // Parse payload
      let payload: {
        ref?: string;
        head_commit?: { id?: string; message?: string };
      };
      try {
        payload = JSON.parse(rawBodyStr);
      } catch {
        return reply.code(400).send({ error: "Invalid JSON payload" });
      }

      const commitSha = payload.head_commit?.id ?? undefined;
      const commitMessage = payload.head_commit?.message ?? undefined;
      const pushedRef = payload.ref ?? "";
      const deploymentIds: string[] = [];

      const repoServices = endpoint.repo?.services ?? [];
      for (const service of repoServices) {
        if (!service.active) continue;
        const expectedRef = `refs/heads/${service.branch}`;
        if (pushedRef !== expectedRef) continue;

        const deployment = await db.deployment.create({
          data: {
            serviceId: service.id,
            status: "queued",
            commitSha,
            commitMessage,
            triggeredBy: "hook",
          },
        });
        enqueueDeployment(service, deployment);
        deploymentIds.push(deployment.id);
        req.log.info(
          { serviceId: service.id, deploymentId: deployment.id, publicId },
          "Hook deployment queued",
        );
      }

      return reply.send({ ok: true, deploymentIds });
    },
  );

  await app.listen({ port: PORT, host: HOST });
  console.log(`[server] Listening on ${HOST}:${PORT}`);
}

main().catch((err) => {
  console.error("[server] Fatal error:", err);
  process.exit(1);
});
