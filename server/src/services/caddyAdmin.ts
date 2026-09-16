import { request } from "node:http";

export function caddyAdminAddress(): string {
  const socket = process.env.CADDY_ADMIN_SOCKET;
  if (!socket) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "Production requires CADDY_ADMIN_SOCKET; TCP admin access is unsafe on the application network.",
      );
    }
    return "0.0.0.0:2019"; // Local development and mock-server tests only.
  }
  if (!/^\/[A-Za-z0-9/_.-]+$/.test(socket))
    throw new Error("Invalid CADDY_ADMIN_SOCKET path");
  return `unix/${socket}`;
}

export async function pushCaddyViaSocket(
  socketPath: string,
  caddyfile: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: "/load",
        method: "POST",
        headers: { Host: "localhost", "Content-Type": "text/caddyfile" },
        signal: AbortSignal.timeout(30_000),
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("error", reject);
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300)
            resolve();
          else
            reject(
              new Error(`Caddy reload failed (${res.statusCode}): ${body}`),
            );
        });
      },
    );
    req.on("error", reject);
    req.end(caddyfile);
  });
}
