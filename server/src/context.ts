import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify'
import { verifyToken, type JwtPayload } from './services/crypto.js'

export type Context = {
  user: JwtPayload | null
  req: CreateFastifyContextOptions['req']
  res: CreateFastifyContextOptions['res']
}

export async function createContext({ req, res }: CreateFastifyContextOptions): Promise<Context> {
  const authHeader = req.headers.authorization ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null

  let user: JwtPayload | null = null
  if (token) {
    try {
      user = verifyToken(token)
    } catch {
      // invalid/expired token — leave user null
    }
  }

  return { user, req, res }
}
