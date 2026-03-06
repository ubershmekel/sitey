/**
 * Caddy Admin API integration.
 *
 * Builds a Caddyfile from DB state (domains + running project containers) and
 * pushes it to Caddy via POST /load. This decouples cert provisioning from
 * container lifecycle — certs are obtained when a domain is added to the DB,
 * and are NOT dropped when a project container is removed.
 *
 * Call reloadCaddy() after:
 *  - Domain created or deleted
 *  - Project container started or stopped
 *  - Server startup
 */

import { db } from '../lib/db.js'
import tls from 'node:tls'

const CADDY_ADMIN_URL = process.env.CADDY_ADMIN_URL ?? 'http://caddy:2019'
const CADDY_ADMIN_ORIGIN = process.env.CADDY_ADMIN_ORIGIN ?? getOriginFromUrl(CADDY_ADMIN_URL)
const CADDY_TLS_HOST = process.env.CADDY_TLS_HOST ?? getHostFromUrl(CADDY_ADMIN_URL)
const CADDY_TLS_PORT = Number(process.env.CADDY_TLS_PORT ?? '443')

export type LetsEncryptStatus = 'pending' | 'active' | 'error'

function getHostFromUrl(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname || 'caddy'
  } catch {
    return 'caddy'
  }
}

function getOriginFromUrl(rawUrl: string): string {
  try {
    return new URL(rawUrl).origin
  } catch {
    return 'http://caddy:2019'
  }
}

function sanitizeDnsName(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, '')
}

function wildcardMatches(pattern: string, hostname: string): boolean {
  if (!pattern.startsWith('*.')) return false
  const suffix = pattern.slice(2)
  if (!hostname.endsWith(`.${suffix}`)) return false
  const hostLabels = hostname.split('.').length
  const suffixLabels = suffix.split('.').length
  return hostLabels === suffixLabels + 1
}

function certMatchesHostname(cert: tls.PeerCertificate, hostname: string): boolean {
  const target = sanitizeDnsName(hostname)
  const dnsNames = (cert.subjectaltname ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(s => s.startsWith('DNS:'))
    .map(s => sanitizeDnsName(s.slice(4)))

  const commonNamesRaw = cert.subject?.CN
  const commonName = (Array.isArray(commonNamesRaw) ? commonNamesRaw : commonNamesRaw ? [commonNamesRaw] : [])
    .map(sanitizeDnsName)
  const candidates = [...dnsNames, ...commonName]

  return candidates.some(name => name === target || wildcardMatches(name, target))
}

export async function getLetsEncryptStatusFromCaddy(hostname: string): Promise<LetsEncryptStatus> {
  return new Promise(resolve => {
    const socket = tls.connect({
      host: CADDY_TLS_HOST,
      port: CADDY_TLS_PORT,
      servername: hostname,
      rejectUnauthorized: false,
      timeout: 5000,
      ALPNProtocols: ['http/1.1'],
    })

    let settled = false
    const finish = (status: LetsEncryptStatus) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(status)
    }

    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate()
      if (!cert || Object.keys(cert).length === 0) {
        finish('pending')
        return
      }
      finish(certMatchesHostname(cert, hostname) ? 'active' : 'pending')
    })
    socket.once('timeout', () => finish('error'))
    socket.once('error', () => finish('error'))
  })
}

export async function getLetsEncryptStatusesFromCaddy(hostnames: string[]): Promise<Record<string, LetsEncryptStatus>> {
  const uniqueHostnames = [...new Set(hostnames.map(h => h.trim().toLowerCase()).filter(Boolean))]
  const results = await Promise.all(
    uniqueHostnames.map(async hostname => [hostname, await getLetsEncryptStatusFromCaddy(hostname)] as const),
  )
  return Object.fromEntries(results)
}

function appendAdminHandlers(lines: string[]): void {
  lines.push('    @api path /trpc/* /webhook/* /health/*')
  lines.push('    handle @api {')
  lines.push('        reverse_proxy sitey-api:3001')
  lines.push('    }')
  lines.push('    handle {')
  lines.push('        reverse_proxy sitey-web:80')
  lines.push('    }')
}

export async function buildCaddyfile(): Promise<string> {
  const domains = await db.domain.findMany({
    orderBy: { createdAt: 'asc' },
    include: {
      routes: {
        include: { project: true },
      },
    },
  })

  const lines: string[] = []

  // Global options — enable admin API so we can push configs
  lines.push('{')
  lines.push('    admin 0.0.0.0:2019')
  lines.push('}')
  lines.push('')

  // Management site (sitey control panel + API)
  const siteyDomain = process.env.SITEY_DOMAIN
  const siteyEmail = process.env.SITEY_EMAIL
  const mgmtHost = siteyDomain || ':80'
  lines.push(`${mgmtHost} {`)
  if (siteyDomain && siteyEmail) {
    lines.push(`    tls ${siteyEmail}`)
  }
  appendAdminHandlers(lines)
  lines.push('}')
  lines.push('')

  // User domains — one block per domain record.
  // A domain block is emitted even when no project is running, so Caddy
  // provisions (and holds) the TLS cert as soon as the domain is added.
  for (const domain of domains) {
    lines.push(`${domain.hostname} {`)
    lines.push(`    tls ${domain.letsEncryptEmail}`)

    const activeRoutes = domain.routes.filter(
      r => r.project?.status === 'running' && r.project?.containerName,
    )

    if (activeRoutes.length > 0) {
      for (const route of activeRoutes) {
        const cname = route.project!.containerName!
        const port = route.project!.containerPort
        if (route.pathPrefix) {
          lines.push(`    handle_path ${route.pathPrefix}/* {`)
          lines.push(`        reverse_proxy ${cname}:${port}`)
          lines.push('    }')
        } else {
          lines.push(`    reverse_proxy ${cname}:${port}`)
        }
      }
    } else {
      // No active project — serve Sitey admin/app on this domain
      appendAdminHandlers(lines)
    }

    lines.push('}')
    lines.push('')
  }

  return lines.join('\n')
}

export async function reloadCaddy(): Promise<void> {
  const caddyfile = await buildCaddyfile()
  const adminUrl = new URL(CADDY_ADMIN_URL)
  const adminPort = adminUrl.port || '2019'

  const originCandidates = [
    CADDY_ADMIN_ORIGIN,
    adminUrl.origin,
    `${adminUrl.protocol}//${adminUrl.host}`,
    `${adminUrl.protocol}//0.0.0.0:${adminPort}`,
    `//${adminUrl.host}`,
    adminUrl.host,
  ]
  const uniqueOrigins = [...new Set(originCandidates.filter(Boolean))]

  let lastError: string | null = null
  for (const origin of uniqueOrigins) {
    const resp = await fetch(`${CADDY_ADMIN_URL}/load`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/caddyfile',
        Origin: origin,
      },
      body: caddyfile,
    })

    if (resp.ok) return

    const body = await resp.text()
    lastError = `Caddy reload failed (${resp.status}) [Origin: ${origin}]: ${body}`

    // Some Caddy builds enforce origin more strictly; try alternate valid origins.
    if (resp.status === 403) continue
    break
  }

  throw new Error(lastError ?? 'Caddy reload failed (unknown error)')
}
