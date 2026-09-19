/**
 * Token authentication for tRPC requests, and API key management for the
 * VPS-local CLI (`sitey token create|list|revoke`).
 *
 * Browsers authenticate with the `sitey_session` cookie (type "session").
 * Remote clients like siteyctl send `Authorization: Bearer <token>` (type
 * "apikey"). Each transport only accepts its own token type, so a leaked
 * session can't be replayed as a bearer token and vice versa.
 *
 * An API key is root-equivalent on the VPS: Sitey controls the Docker socket.
 */

import fs from "node:fs";
import path from "node:path";
import { db } from "../lib/db.ts";
import { generateToken, hashToken } from "./crypto.ts";

/** Recognizable prefix so leaked keys are easy to spot (and to grep for). */
export const API_TOKEN_PREFIX = "sitey_";

export type TokenTransport = "cookie" | "bearer";

const TOKEN_TYPE_BY_TRANSPORT: Record<TokenTransport, string> = {
  cookie: "session",
  bearer: "apikey",
};

export type AuthenticatedUser = {
  sub: string;
  email: string;
  mustChangePassword: boolean;
};

type StoredToken = {
  id: string;
  type: string;
  expiresAt: Date | null;
  user: { id: string; email: string; mustChangePassword: boolean };
};

export type TokenStore = {
  findByHash(tokenHash: string): Promise<StoredToken | null>;
  remove(id: string): Promise<unknown>;
  touch(id: string): Promise<unknown>;
};

const dbTokenStore: TokenStore = {
  findByHash: (tokenHash) =>
    db.token.findUnique({
      where: { tokenHash },
      include: {
        user: { select: { id: true, email: true, mustChangePassword: true } },
      },
    }),
  remove: (id) => db.token.delete({ where: { id } }),
  touch: (id) =>
    db.token.update({ where: { id }, data: { lastUsedAt: new Date() } }),
};

/** Extracts the token from an `Authorization: Bearer <token>` header. */
export function readBearerToken(header: string | undefined): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return match ? match[1] : null;
}

export async function authenticateToken(
  raw: string,
  transport: TokenTransport,
  store: TokenStore = dbTokenStore,
  now = new Date(),
): Promise<AuthenticatedUser | null> {
  const token = await store.findByHash(hashToken(raw));
  if (!token) return null;
  if (token.type !== TOKEN_TYPE_BY_TRANSPORT[transport]) return null;
  if (token.expiresAt && token.expiresAt < now) {
    // Expired — clean up and reject
    store.remove(token.id).catch(() => {});
    return null;
  }

  // Fire-and-forget lastUsedAt update
  store.touch(token.id).catch(() => {});

  return {
    sub: token.user.id,
    email: token.user.email,
    mustChangePassword: token.user.mustChangePassword,
  };
}

// ── API key management (VPS-local CLI) ────────────────────────────────────────

export class ApiTokenError extends Error {}

const TOKEN_NAME_REGEX = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * The token the VPS's own `siteyctl` uses (deploy/siteyctl). It lives in a file
 * on the sitey-api container's filesystem, never the host's /data mount, so
 * reading it takes `docker exec` (already root on the VPS). It's a normal API
 * token: listed, revocable, and recreated on the next siteyctl run after
 * `sitey token revoke local-cli`.
 */
export const LOCAL_CLI_TOKEN_NAME = "local-cli";
/** Keep in sync with LOCAL_SERVER_FILE in siteyctl/src/profiles.ts. */
export const LOCAL_CLI_FILE = "/run/sitey/local-cli.json";

async function findTokenUser(userEmail?: string) {
  const user = userEmail
    ? await db.user.findUnique({ where: { email: userEmail } })
    : await db.user.findFirst({ orderBy: { createdAt: "asc" } });
  if (!user) {
    throw new ApiTokenError(
      userEmail
        ? `No user with email ${userEmail}.`
        : "No users yet. Finish setup in the web UI first.",
    );
  }
  return user;
}

async function insertApiToken(
  userId: string,
  name: string,
  client: Pick<typeof db, "token"> = db,
): Promise<string> {
  const token = API_TOKEN_PREFIX + generateToken();
  await client.token.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      type: "apikey",
      name,
      expiresAt: null,
    },
  });
  return token;
}

export async function createApiToken(
  name: string,
  userEmail?: string,
): Promise<{ token: string; name: string; email: string }> {
  if (!TOKEN_NAME_REGEX.test(name)) {
    throw new ApiTokenError(
      "Token names are 1-64 characters: letters, digits, '.', '_' or '-'.",
    );
  }
  if (name === LOCAL_CLI_TOKEN_NAME) {
    throw new ApiTokenError(
      `"${LOCAL_CLI_TOKEN_NAME}" is reserved for siteyctl on this VPS. Pick another name.`,
    );
  }
  const user = await findTokenUser(userEmail);
  const existing = await db.token.findFirst({
    where: { type: "apikey", name },
    select: { id: true },
  });
  if (existing) {
    throw new ApiTokenError(
      `A token named "${name}" already exists. Revoke it first or pick another name.`,
    );
  }
  const token = await insertApiToken(user.id, name);
  return { token, name, email: user.email };
}

/**
 * Replaces the local-cli token (for the first user) and writes its file.
 * The swap is one transaction, so there's never more than one local-cli token.
 * Concurrent callers are serialized by deploy/siteyctl's flock; without it, a
 * racing caller could still overwrite the file with a token that was just
 * revoked (the next siteyctl error says how to reset it).
 */
export async function writeLocalCliToken(
  port: number,
  file = LOCAL_CLI_FILE,
): Promise<void> {
  const user = await findTokenUser();
  const token = await db.$transaction(async (tx) => {
    await tx.token.deleteMany({
      where: { type: "apikey", name: LOCAL_CLI_TOKEN_NAME },
    });
    return insertApiToken(user.id, LOCAL_CLI_TOKEN_NAME, tx);
  });
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  const body = { url: `http://127.0.0.1:${port}`, token };
  fs.writeFileSync(tmp, `${JSON.stringify(body)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export async function listApiTokens() {
  return db.token.findMany({
    where: { type: "apikey" },
    orderBy: { createdAt: "asc" },
    select: {
      name: true,
      createdAt: true,
      lastUsedAt: true,
      expiresAt: true,
      user: { select: { email: true } },
    },
  });
}

export async function revokeApiToken(
  name: string,
  file = LOCAL_CLI_FILE,
): Promise<number> {
  const { count } = await db.token.deleteMany({
    where: { type: "apikey", name },
  });
  // The next siteyctl run on the VPS mints a fresh one.
  if (name === LOCAL_CLI_TOKEN_NAME) fs.rmSync(file, { force: true });
  return count;
}
