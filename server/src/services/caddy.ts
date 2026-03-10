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
// Host:port that Caddy (inside Docker) uses to reach the sitey-api.
// In production this is "sitey-api:3001" (Docker service name).
// In host-run dev, default to host.docker.internal.
const IS_HOST_RUN_DEV = isLocalAdminUrl(CADDY_ADMIN_URL)
const SITEY_API_INTERNAL = process.env.SITEY_API_INTERNAL ?? (IS_HOST_RUN_DEV ? 'host.docker.internal:3001' : 'sitey-api:3001')
// When set, Caddy proxies the web SPA to this host instead of serving /srv/web.
// Keep this opt-in so Caddy can fall back to baked /srv/web when Vite isn't running.
const SITEY_WEB_INTERNAL = process.env.SITEY_WEB_INTERNAL ?? ''
const WILDCARD_STATUS_PROBE_LABEL = 'sitey-dns-check'

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

function isLocalAdminUrl(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
  } catch {
    return false
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

export function getWildcardStatusProbeHostname(wildcardHostname: string): string | null {
  const normalized = sanitizeDnsName(wildcardHostname)
  if (!normalized.startsWith('*.')) return null
  return `${WILDCARD_STATUS_PROBE_LABEL}.${normalized.slice(2)}`
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
  const wildcardHostnames = uniqueHostnames.filter(hostname => hostname.startsWith('*.'))
  const concreteHostnames = uniqueHostnames.filter(hostname => !hostname.startsWith('*.'))

  const concreteChecks = concreteHostnames
    .map(async hostname => [hostname, await getLetsEncryptStatusFromCaddy(hostname)] as const)
  const wildcardChecks = wildcardHostnames
    .map(async hostname => {
      const probeHostname = getWildcardStatusProbeHostname(hostname)
      if (!probeHostname) return [hostname, 'pending'] as const
      return [hostname, await getLetsEncryptStatusFromCaddy(probeHostname)] as const
    })

  const results = await Promise.all([...concreteChecks, ...wildcardChecks])
  return Object.fromEntries(results)
}

function appendAdminHandlers(lines: string[]): void {
  lines.push('    @api path /trpc/* /webhook/* /health/*')
  lines.push('    handle @api {')
  lines.push(`        reverse_proxy ${SITEY_API_INTERNAL}`)
  lines.push('    }')
  lines.push('    handle {')
  if (SITEY_WEB_INTERNAL) {
    lines.push(`        reverse_proxy ${SITEY_WEB_INTERNAL}`)
  } else {
    lines.push('        root * /srv/web')
    lines.push('        try_files {path} /index.html')
    lines.push('        file_server')
  }
  lines.push('    }')
}

type ActiveRoute = {
  subdomain: string
  pathPrefix: string
  project: {
    id: number
    deployMode: string
    outputDir: string
    containerName: string | null
    containerPort: number
  } | null
}

function resolveRouteHostname(domainHostname: string, routeSubdomain: string): string | null {
  if (!domainHostname.startsWith('*.')) return domainHostname
  const base = domainHostname.slice(2)
  const label = routeSubdomain.trim().toLowerCase()
  if (!label) return null
  return `${label}.${base}`
}

function appendRouteHandler(lines: string[], route: ActiveRoute): void {
  const project = route.project!
  if (project.deployMode === 'static') {
    const repoBase = `/srv/projects/${project.id}/repo`
    const dir = project.outputDir ? `${repoBase}/${project.outputDir}` : repoBase
    if (route.pathPrefix) {
      lines.push(`    handle_path ${route.pathPrefix}/* {`)
      lines.push(`        root * ${dir}`)
      lines.push('        try_files {path} /index.html')
      lines.push('        file_server')
      lines.push('    }')
    } else {
      lines.push(`    root * ${dir}`)
      lines.push('    try_files {path} /index.html')
      lines.push('    file_server')
    }
  } else {
    const cname = project.containerName!
    const port = project.containerPort
    if (route.pathPrefix) {
      lines.push(`    handle_path ${route.pathPrefix}/* {`)
      lines.push(`        reverse_proxy ${cname}:${port}`)
      lines.push('    }')
    } else {
      lines.push(`    reverse_proxy ${cname}:${port}`)
    }
  }
}

function appendSiteBlock(lines: string[], hostname: string, email: string, routes: ActiveRoute[]): void {
  lines.push(`${hostname} {`)
  lines.push(`    tls ${email}`)
  if (routes.length > 0) {
    for (const route of routes) appendRouteHandler(lines, route)
  } else {
    appendAdminHandlers(lines)
  }
  lines.push('}')
  lines.push('')
}

function appendProbeSiteBlock(lines: string[], hostname: string, email: string): void {
  lines.push(`${hostname} {`)
  lines.push(`    tls ${email}`)
  lines.push('    respond 204')
  lines.push('}')
  lines.push('')
}

export async function buildCaddyfile(): Promise<string> {
  const domains = await db.domain.findMany({
    orderBy: { createdAt: 'asc' },
    include: {
      routes: {
        orderBy: { createdAt: 'asc' },
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

  // User domains.
  // For wildcard domains, we emit concrete host blocks per route subdomain
  // (for example: app.example.com) instead of a raw "*.example.com" block.
  for (const domain of domains) {
    const activeRoutes = domain.routes
      .filter(r => {
        const p = r.project
        if (!p) return false
        return p.deployMode === 'static' || !!p.containerName
      }) as ActiveRoute[]

    if (!domain.hostname.startsWith('*.')) {
      appendSiteBlock(lines, domain.hostname, domain.letsEncryptEmail, activeRoutes)
      continue
    }

    const routesByHostname = new Map<string, ActiveRoute[]>()
    for (const route of activeRoutes) {
      const routeHostname = resolveRouteHostname(domain.hostname, route.subdomain)
      if (!routeHostname) continue
      const existing = routesByHostname.get(routeHostname)
      if (existing) existing.push(route)
      else routesByHostname.set(routeHostname, [route])
    }

    const probeHostname = getWildcardStatusProbeHostname(domain.hostname)
    const mgmtHostname = siteyDomain ? sanitizeDnsName(siteyDomain) : null
    if (probeHostname && !routesByHostname.has(probeHostname) && probeHostname !== mgmtHostname) {
      appendProbeSiteBlock(lines, probeHostname, domain.letsEncryptEmail)
    }

    if ((domain as any).siteySubdomainsEnabled) {
      const siteySubdomain = `sitey.${domain.hostname.slice(2)}`
      // Skip if the management site already owns this hostname (avoids duplicate block)
      const mgmtOwnsIt = siteyDomain && sanitizeDnsName(siteyDomain) === sanitizeDnsName(siteySubdomain)
      if (!mgmtOwnsIt && !routesByHostname.has(siteySubdomain)) {
        appendSiteBlock(lines, siteySubdomain, domain.letsEncryptEmail, [])
      }
    }

    for (const [hostname, hostRoutes] of routesByHostname.entries()) {
      if (hostname === mgmtHostname) continue // management block already owns this hostname
      appendSiteBlock(lines, hostname, domain.letsEncryptEmail, hostRoutes)
    }
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Background TLS status refresh — stale-while-revalidate
// ---------------------------------------------------------------------------

const STALE_TTL_MS = 5 * 60 * 1000 // 5 minutes
const inFlightRefreshes = new Set<number>() // domain IDs currently being probed

export function isDomainStatusStale(statusCheckedAt: Date | null): boolean {
  if (!statusCheckedAt) return true
  return Date.now() - statusCheckedAt.getTime() > STALE_TTL_MS
}

export function scheduleDomainStatusRefresh(domain: { id: number; hostname: string }): void {
  if (inFlightRefreshes.has(domain.id)) return // already in-flight

  inFlightRefreshes.add(domain.id)

  const probeHostname = domain.hostname.startsWith('*.')
    ? (getWildcardStatusProbeHostname(domain.hostname) ?? domain.hostname)
    : domain.hostname

  getLetsEncryptStatusFromCaddy(probeHostname)
    .then(
      status => db.domain.update({ where: { id: domain.id }, data: { status, statusCheckedAt: new Date() } }),
      err => {
        console.error(`[caddy] Background status refresh failed for ${domain.hostname}:`, err)
        return db.domain.update({ where: { id: domain.id }, data: { status: 'error', statusCheckedAt: new Date() } })
      },
    )
    .catch(err => console.error(`[caddy] Failed to persist status for ${domain.hostname}:`, err))
    .finally(() => inFlightRefreshes.delete(domain.id))
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

