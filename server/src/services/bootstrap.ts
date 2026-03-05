/**
 * First-run bootstrap:
 *  1. Run pending Prisma migrations.
 *  2. Ensure a JWT secret exists in SystemConfig (generate one if not).
 *  3. Call initJwtSecret() so the crypto module is ready before the server starts.
 *  4. Print the server's local IP addresses so the user knows where to connect.
 */

import os from 'node:os'
import crypto from 'node:crypto'
import { db } from '../lib/db.js'
import { initJwtSecret } from './crypto.js'

export async function bootstrap() {
  await db.$connect()

  // ── JWT secret ─────────────────────────────────────────────────────────────
  let secretRow = await db.systemConfig.findUnique({ where: { key: 'jwt_secret' } })
  if (!secretRow) {
    const generated = crypto.randomBytes(32).toString('hex')
    secretRow = await db.systemConfig.create({ data: { key: 'jwt_secret', value: generated } })
    console.log('[bootstrap] Generated new JWT secret.')
  }
  initJwtSecret(secretRow.value)

  // ── First-run hint ─────────────────────────────────────────────────────────
  const setupDone = await db.systemConfig.findUnique({ where: { key: 'setup_complete' } })
  if (!setupDone) {
    const ips = getLocalIPs()
    console.log('╔══════════════════════════════════════════════════════╗')
    console.log('║          SITEY — FIRST RUN SETUP                     ║')
    console.log('║                                                       ║')
    console.log('║  Open one of these addresses in your browser:        ║')
    ips.forEach(ip => {
      const line = `  http://${ip}`
      console.log(`║  ${line.padEnd(51)}║`)
    })
    console.log('║                                                       ║')
    console.log('║  Complete the setup wizard to create your account.   ║')
    console.log('╚══════════════════════════════════════════════════════╝')
  }
}

function getLocalIPs(): string[] {
  const results: string[] = []
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        results.push(addr.address)
      }
    }
  }
  return results.length ? results : ['localhost']
}

// ── Password reset (CLI) ───────────────────────────────────────────────────────

export async function resetAdminPassword() {
  const { generatePassword, hashPassword } = await import('./crypto.js')

  const user = await db.user.findFirst({ orderBy: { createdAt: 'asc' } })
  if (!user) {
    console.error('[reset] No users found.')
    process.exit(1)
  }

  const newPassword = generatePassword(24)
  const hash = await hashPassword(newPassword)

  await db.user.update({
    where: { id: user.id },
    data: { passwordHash: hash, mustChangePassword: true },
  })

  console.log('╔══════════════════════════════════════════════════════╗')
  console.log('║          SITEY — ADMIN PASSWORD RESET                ║')
  console.log('║                                                       ║')
  console.log(`║  Email   : ${user.email.padEnd(41)}║`)
  console.log(`║  Password: ${newPassword.padEnd(41)}║`)
  console.log('║                                                       ║')
  console.log('║  You will be required to change this password on     ║')
  console.log('║  next login.                                         ║')
  console.log('╚══════════════════════════════════════════════════════╝')

  await db.$disconnect()
}

// Allow running directly: `tsx src/services/bootstrap.ts reset`
import { fileURLToPath } from 'node:url'
const isMain = process.argv[1] === fileURLToPath(import.meta.url) ||
               process.argv[1]?.endsWith('bootstrap.js')

if (isMain && process.argv[2] === 'reset') {
  await db.$connect()
  await resetAdminPassword()
}
