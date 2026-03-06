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

const CADDY_ADMIN_URL = process.env.CADDY_ADMIN_URL ?? 'http://caddy:2019'

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
  lines.push('    @api path /trpc/* /webhook/* /health/*')
  lines.push('    handle @api {')
  lines.push('        reverse_proxy sitey-api:3001')
  lines.push('    }')
  lines.push('    handle {')
  lines.push('        reverse_proxy sitey-web:80')
  lines.push('    }')
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
      // No active project — 503 placeholder while cert is provisioned/held
      lines.push('    respond "Service not available" 503')
    }

    lines.push('}')
    lines.push('')
  }

  return lines.join('\n')
}

export async function reloadCaddy(): Promise<void> {
  const caddyfile = await buildCaddyfile()
  const resp = await fetch(`${CADDY_ADMIN_URL}/load`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/caddyfile' },
    body: caddyfile,
  })
  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(`Caddy reload failed (${resp.status}): ${body}`)
  }
}
