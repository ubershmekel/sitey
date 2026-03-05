/**
 * First-run bootstrap:
 *  1. Run pending Prisma migrations.
 *  2. If no User exists, generate a random admin password, print it to logs,
 *     store only the argon2 hash, and set mustChangePassword = true.
 *  3. Store whether first-run setup has been completed in SystemConfig.
 */

import { db } from '../lib/db.js'
import { generatePassword, hashPassword } from './crypto.js'

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@sitey.local'

export async function bootstrap() {
  // Ensure we can reach the DB
  await db.$connect()

  const userCount = await db.user.count()
  if (userCount > 0) {
    console.log('[bootstrap] Admin user already exists — skipping first-run setup.')
    return
  }

  const password = generatePassword(24)
  const hash = await hashPassword(password)

  await db.user.create({
    data: {
      email: ADMIN_EMAIL,
      passwordHash: hash,
      mustChangePassword: true,
    },
  })

  await db.systemConfig.upsert({
    where: { key: 'first_run_complete' },
    create: { key: 'first_run_complete', value: 'true' },
    update: { value: 'true' },
  })

  // Print once to stdout — visible in `docker compose logs sitey-api`
  console.log('╔══════════════════════════════════════════════════════╗')
  console.log('║          SITEY — FIRST RUN ADMIN CREDENTIALS         ║')
  console.log('║                                                       ║')
  console.log(`║  Email   : ${ADMIN_EMAIL.padEnd(41)}║`)
  console.log(`║  Password: ${password.padEnd(41)}║`)
  console.log('║                                                       ║')
  console.log('║  You will be required to change this password on     ║')
  console.log('║  first login. Keep it safe until then.               ║')
  console.log('╚══════════════════════════════════════════════════════╝')
}

// ── Password reset (CLI) ───────────────────────────────────────────────────────

export async function resetAdminPassword() {
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
// Guard: only execute when this file is the direct entry point, not when imported.
import { fileURLToPath } from 'node:url'
const isMain = process.argv[1] === fileURLToPath(import.meta.url) ||
               process.argv[1]?.endsWith('bootstrap.js')

if (isMain && process.argv[2] === 'reset') {
  await db.$connect()
  await resetAdminPassword()
}
