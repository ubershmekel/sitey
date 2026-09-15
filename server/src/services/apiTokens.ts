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

export async function createApiToken(
  name: string,
  userEmail?: string,
): Promise<{ token: string; name: string; email: string }> {
  if (!TOKEN_NAME_REGEX.test(name)) {
    throw new ApiTokenError(
      "Token names are 1-64 characters: letters, digits, '.', '_' or '-'.",
    );
  }
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
  const existing = await db.token.findFirst({
    where: { type: "apikey", name },
    select: { id: true },
  });
  if (existing) {
    throw new ApiTokenError(
      `A token named "${name}" already exists. Revoke it first or pick another name.`,
    );
  }

  const token = API_TOKEN_PREFIX + generateToken();
  await db.token.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(token),
      type: "apikey",
      name,
      expiresAt: null,
    },
  });
  return { token, name, email: user.email };
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

export async function revokeApiToken(name: string): Promise<number> {
  const { count } = await db.token.deleteMany({
    where: { type: "apikey", name },
  });
  return count;
}
