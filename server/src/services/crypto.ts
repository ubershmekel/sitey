import crypto from 'node:crypto'
import argon2 from 'argon2'
import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_SECRET ?? (() => {
  console.warn('[crypto] JWT_SECRET not set — using insecure random. Set JWT_SECRET in .env!')
  return crypto.randomBytes(32).toString('hex')
})()

// ── Password helpers ──────────────────────────────────────────────────────────

export function generatePassword(length = 24): string {
  // Use alphanumeric + special chars, URL-safe
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%^&*'
  const bytes = crypto.randomBytes(length)
  return Array.from(bytes).map(b => chars[b % chars.length]).join('')
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id })
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return argon2.verify(hash, password)
}

// ── JWT helpers ───────────────────────────────────────────────────────────────

export type JwtPayload = {
  sub: string   // user id
  email: string
  mustChangePassword: boolean
}

export function signToken(payload: JwtPayload, expiresIn = '7d'): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn } as jwt.SignOptions)
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET) as JwtPayload
}

// ── Webhook secret helpers ────────────────────────────────────────────────────

export function generateWebhookSecret(length = 32): string {
  return crypto.randomBytes(length).toString('hex')
}

export function verifyWebhookSignature(
  payload: Buffer | string,
  secret: string,
  signatureHeader: string, // "sha256=<hex>"
): boolean {
  const sig = crypto
    .createHmac('sha256', secret)
    .update(typeof payload === 'string' ? Buffer.from(payload) : payload)
    .digest('hex')
  const expected = `sha256=${sig}`
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader))
  } catch {
    return false
  }
}

// ── Reset token helpers ───────────────────────────────────────────────────────

export function generateResetToken(): string {
  return crypto.randomBytes(32).toString('hex')
}
