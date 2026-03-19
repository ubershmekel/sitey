import type { CreateFastifyContextOptions } from "@trpc/server/adapters/fastify";
import { hashToken } from "./services/crypto.js";
import { db } from "./lib/db.js";

export type UserContext = {
  sub: string;
  email: string;
  mustChangePassword: boolean;
};

export type Context = {
  user: UserContext | null;
  req: CreateFastifyContextOptions["req"];
  res: CreateFastifyContextOptions["res"];
};

export async function createContext({
  req,
  res,
}: CreateFastifyContextOptions): Promise<Context> {
  const raw: string | undefined = (
    req as unknown as { cookies: Record<string, string> }
  ).cookies?.sitey_session;
  if (!raw) return { user: null, req, res };

  const tokenHash = hashToken(raw);
  const token = await db.token.findUnique({
    where: { tokenHash },
    include: {
      user: { select: { id: true, email: true, mustChangePassword: true } },
    },
  });

  if (!token) return { user: null, req, res };
  if (token.expiresAt && token.expiresAt < new Date()) {
    // Expired — clean up and reject
    db.token.delete({ where: { id: token.id } }).catch(() => {});
    return { user: null, req, res };
  }

  // Fire-and-forget lastUsedAt update
  db.token
    .update({ where: { id: token.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  return {
    user: {
      sub: token.user.id,
      email: token.user.email,
      mustChangePassword: token.user.mustChangePassword,
    },
    req,
    res,
  };
}
