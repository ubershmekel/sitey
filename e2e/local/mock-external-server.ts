/**
 * Mock external HTTP server for E2E tests.
 *
 * Intercepts outbound calls from the Sitey API that would otherwise hit real
 * external services (Caddy admin, GitHub API, IP-detect services) and returns
 * controlled responses.  All POST /caddy/load requests are logged so tests
 * can inspect Caddyfile content.
 *
 * Paths mirror the env vars used by the API:
 *   CADDY_ADMIN_URL    → http://localhost:3334/caddy   (POST /caddy/load)
 *   GITHUB_API_BASE    → http://localhost:3334/github  (GET/POST /github/...)
 *   DETECT_IP_SERVICES → http://localhost:3334/detectip (GET /detectip)
 */

import Fastify, { type FastifyInstance } from "fastify";

type RequestLogEntry = {
  method: string;
  path: string;
  body: string;
};

export function createMockServer(): {
  app: FastifyInstance;
  requests: RequestLogEntry[];
} {
  const requests: RequestLogEntry[] = [];
  const app = Fastify({ logger: false });

  // Caddy sends the Caddyfile as `text/caddyfile` — Fastify won't parse it by
  // default and returns 415.  Register a plain-string parser for that type.
  app.addContentTypeParser(
    "text/caddyfile",
    { parseAs: "string" },
    (_req, body, done) => done(null, body),
  );

  // Caddy Admin API — POST /caddy/load
  // The Sitey API posts the full Caddyfile here on startup and on every change.
  app.post("/caddy/load", async (req, reply) => {
    requests.push({
      method: "POST",
      path: "/caddy/load",
      body: typeof req.body === "string" ? req.body : JSON.stringify(req.body),
    });
    return reply.code(200).send("");
  });

  // Caddy Admin API — GET /caddy/config/ (used by some Caddy health checks)
  app.get("/caddy/config/", async (_req, reply) => {
    return reply.code(200).send({ apps: {} });
  });

  // GitHub API — find installation for a repo
  app.get("/github/repos/:owner/:repo/installation", async (_req, reply) => {
    return reply.code(200).send({ id: 42 });
  });

  // GitHub API — mint installation access token
  app.post(
    "/github/app/installations/42/access_tokens",
    async (_req, reply) => {
      return reply.code(201).send({
        token: "mock-github-token",
        expires_at: "2099-01-01T00:00:00Z",
      });
    },
  );

  // IP detection service — returns a fake public IPv4 address
  app.get("/detectip", async (_req, reply) => {
    return reply.code(200).type("text/plain").send("1.2.3.4");
  });

  // Inspection endpoint — tests fetch this to read the Caddyfile log
  app.get("/__requests", async (_req, reply) => {
    return reply.code(200).send(requests);
  });

  return { app, requests };
}

export async function start(
  port: number,
): Promise<{ url: string; stop: () => Promise<void> }> {
  const { app } = createMockServer();
  await app.listen({ port, host: "127.0.0.1" });
  const url = `http://127.0.0.1:${port}`;
  return { url, stop: () => app.close() };
}

// ── Standalone CLI entrypoint ─────────────────────────────────────────────────
const isMain = process.argv[1]?.endsWith("mock-external-server.ts");

if (isMain) {
  const port = parseInt(process.env.MOCK_PORT ?? "3334", 10);
  start(port).then(({ url }) => {
    console.log(`[mock-server] Listening on ${url}`);
  });
}
