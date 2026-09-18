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

/** Caddy answered, and refused the config (as opposed to being unreachable). */
export class CaddyRejectedError extends Error {}

function postViaSocket(
  socketPath: string,
  urlPath: "/load" | "/adapt",
  caddyfile: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: urlPath,
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
            resolve(body);
          else
            reject(
              new CaddyRejectedError(
                `Caddy ${urlPath === "/load" ? "reload" : "adapt"} failed (${res.statusCode}): ${body}`,
              ),
            );
        });
      },
    );
    req.on("error", reject);
    req.end(caddyfile);
  });
}

export async function pushCaddyViaSocket(
  socketPath: string,
  caddyfile: string,
): Promise<void> {
  await postViaSocket(socketPath, "/load", caddyfile);
}

/** Runs a Caddyfile through Caddy's adapter without loading it. Returns JSON. */
export function adaptCaddyfileViaSocket(
  socketPath: string,
  caddyfile: string,
): Promise<string> {
  return postViaSocket(socketPath, "/adapt", caddyfile);
}
