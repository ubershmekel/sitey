import type { CreateFastifyContextOptions } from "@trpc/server/adapters/fastify";
import {
  authenticateToken,
  readBearerToken,
  type AuthenticatedUser,
} from "./services/apiTokens.ts";

export type UserContext = AuthenticatedUser;

export type Context = {
  user: UserContext | null;
  req: CreateFastifyContextOptions["req"];
  res: CreateFastifyContextOptions["res"];
};

export async function createContext({
  req,
  res,
}: CreateFastifyContextOptions): Promise<Context> {
  // A bearer token (siteyctl) takes precedence. If one is sent but invalid, the
  // request is unauthenticated — never silently fall back to a cookie.
  const authorization = req.headers.authorization;
  if (authorization) {
    const bearer = readBearerToken(authorization);
    const user = bearer ? await authenticateToken(bearer, "bearer") : null;
    return { user, req, res };
  }

  const raw: string | undefined = (
    req as unknown as { cookies: Record<string, string> }
  ).cookies?.sitey_session;
  if (!raw) return { user: null, req, res };

  return { user: await authenticateToken(raw, "cookie"), req, res };
}
