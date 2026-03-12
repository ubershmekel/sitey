<template>
  <Layout>
    <div v-if="loading" class="state-msg">Loading…</div>
    <div v-else-if="error" class="alert error">{{ error }}</div>
    <template v-else-if="domain">
      <div class="breadcrumb">
        <RouterLink to="/domains">Domains</RouterLink> / {{ domain.hostname }}
      </div>

      <h1>{{ domain.hostname }}</h1>

      <div class="page-actions">
        <button v-if="isWildcard" class="btn-primary" :disabled="editSaving" @click="saveEdit">
          {{ editSaving ? 'Saving…' : 'Save changes' }}
        </button>
        <button class="btn-primary" @click="showAddProject = true">+ Add project</button>
      </div>

      <div v-if="editError" class="alert error">{{ editError }}</div>
      <div v-if="saveSucceeded" class="alert success">Changes saved.</div>

      <div class="domain-section">
        <div class="field-row">
          <span class="field-label">HTTPS</span>
          <span :class="`status status-${domain.status}`">{{ tlsLabel(domain.status) }}</span>
        </div>
        <p v-if="domain.status === 'error'" class="tls-hint">
          Caddy could not load TLS config. Look at the Caddy logs below and review the generated Caddyfile in
          Settings.
        </p>
        <div v-if="domain.status === 'error'" class="caddy-logs">
          <div class="caddy-logs-header">
            <span>Caddy logs</span>
            <button type="button" class="btn-ghost-sm" :disabled="caddyLogsLoading" @click="loadCaddyLogs">
              {{ caddyLogsLoading ? 'Loading...' : 'Refresh' }}
            </button>
          </div>
          <div v-if="caddyLogsError" class="alert error caddy-logs-error">{{ caddyLogsError }}</div>
          <div class="log-box">
            <div v-if="caddyLogLines.length === 0" class="log-empty">No logs yet.</div>
            <pre v-else class="log-content">{{ caddyLogLines.join('\n') }}</pre>
          </div>
        </div>

        <div v-if="isWildcard" class="field-row sitey-subdomain-row">
          <label class="checkbox-label">
            <input v-model="editSiteySubdomains" type="checkbox" />
            Enable Sitey subdomains
          </label>
          <a v-if="editSiteySubdomains" :href="`https://sitey.${domain.hostname.slice(2)}`" target="_blank"
            rel="noopener" class="sitey-subdomain-link">
            sitey.{{ domain.hostname.slice(2) }} ↗
          </a>
        </div>

        <div class="dns-check">
          <div class="dns-row">
            <span class="dns-label">{{ domain.hostname }}</span>
            <span v-if="dnsResult === null" class="dns-status dns-checking">checking…</span>
            <span v-else-if="dnsResult.resolves" class="dns-status dns-ok">
              resolves → {{ dnsResult.addresses.join(', ') }}
            </span>
            <span v-else class="dns-status dns-fail">DNS not resolving</span>
            <button type="button" class="btn-recheck" @click="checkDns">↻</button>
          </div>
          <p class="dns-hint">DNS must point to this server before deploying.</p>
        </div>
      </div>

      <h2 class="section-title">Projects</h2>

      <div v-if="domainProjects.length === 0" class="empty-state">
        <p>No projects yet. Add one to deploy an app to this domain.</p>
        <button class="btn-primary mt-1" @click="showAddProject = true">Add project</button>
      </div>
      <div v-else class="project-list">
        <RouterLink v-for="p in domainProjects" :key="p.id" :to="`/projects/${p.id}`" class="project-card">
          <div class="project-left">
            <div class="project-name">{{ p.name }}</div>
            <div class="project-repo">{{ p.repoOwner }}/{{ p.repoName }}:{{ p.branch }}</div>
          </div>
          <div class="project-right">
            <span :class="`status status-${p.status}`">{{ p.status }}</span>
            <span v-if="p.deployments[0]" class="last-deploy">
              {{ relativeTime(p.deployments[0].createdAt) }}
            </span>
          </div>
        </RouterLink>
      </div>

      <div class="danger-zone">
        <h2>Danger zone</h2>
        <p class="danger-desc">Deleting this domain removes all its routes. This cannot be undone.</p>
        <button class="btn-danger" :disabled="deletingDomain" @click="deleteDomain">
          {{ deletingDomain ? 'Deleting…' : 'Delete domain' }}
        </button>
      </div>
    </template>

    <AddProjectModal
      v-model="showAddProject"
      title="Add project"
      :fixed-domain-id="domainId"
      @created="handleProjectCreated"
    />
  </Layout>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import AddProjectModal from '../components/AddProjectModal.vue'
import Layout from '../components/Layout.vue'
import { trpc } from '../trpc'

type Domain = Awaited<ReturnType<typeof trpc.domains.get.query>>

const route = useRoute()
const router = useRouter()
const domainId = Number(route.params.id)

const domain = ref<Domain | null>(null)
const loading = ref(true)
const error = ref('')

const showAddProject = ref(false)

const editSiteySubdomains = ref(false)
const editSaving = ref(false)
const editError = ref('')
const saveSucceeded = ref(false)
const deletingDomain = ref(false)
const caddyLogLines = ref<string[]>([])
const caddyLogsLoading = ref(false)
const caddyLogsError = ref('')

const isWildcard = computed(() => domain.value?.hostname.startsWith('*.') ?? false)
type DnsResult = { resolves: boolean; addresses: string[] } | null
const dnsResult = ref<DnsResult>(null)

async function checkDns() {
  if (!domain.value) return
  dnsResult.value = null
  dnsResult.value = await trpc.domains.checkDns.query({ hostname: domain.value.hostname })
}

async function saveEdit() {
  editError.value = ''
  saveSucceeded.value = false
  editSaving.value = true
  try {
    await trpc.domains.update.mutate({
      id: domainId,
      ...(isWildcard.value ? { siteySubdomainsEnabled: editSiteySubdomains.value } : {}),
    })
    saveSucceeded.value = true
    setTimeout(() => {
      saveSucceeded.value = false
    }, 3000)
    await fetchDomain()
  } catch (e: unknown) {
    editError.value = (e as { message?: string })?.message ?? 'Failed to save'
  } finally {
    editSaving.value = false
  }
}

async function loadCaddyLogs() {
  if (!domain.value || domain.value.status !== 'error') return
  caddyLogsLoading.value = true
  caddyLogsError.value = ''
  try {
    const res = await trpc.domains.getCaddyLogs.query({ tail: 200 })
    caddyLogLines.value = res.lines
  } catch (e: unknown) {
    caddyLogsError.value = (e as { message?: string })?.message ?? 'Failed to load Caddy logs'
  } finally {
    caddyLogsLoading.value = false
  }
}

function normalizeHostnameInput(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, '')
}

function wildcardMatches(pattern: string, hostname: string): boolean {
  if (!pattern.startsWith('*.')) return false
  const suffix = pattern.slice(2)
  if (!hostname.endsWith(`.${suffix}`)) return false
  const hostLabels = hostname.split('.').length
  const suffixLabels = suffix.split('.').length
  return hostLabels === suffixLabels + 1
}

function deletingCurrentSiteDomain(hostname: string): boolean {
  const target = normalizeHostnameInput(hostname)
  const currentHost = normalizeHostnameInput(window.location.hostname)
  return target === currentHost || wildcardMatches(target, currentHost)
}

async function deleteDomain() {
  if (!domain.value || deletingDomain.value) return
  const hostname = domain.value.hostname
  const inUseWarning = deletingCurrentSiteDomain(hostname)
    ? '\n\nWARNING: You are currently using this domain to access Sitey. Deleting it may break this URL immediately.'
    : ''

  if (!confirm(`Delete domain "${hostname}"? This will remove all its routes.${inUseWarning}`)) return

  deletingDomain.value = true
  error.value = ''
  try {
    await trpc.domains.delete.mutate({ id: domainId })
    await router.push('/')
  } catch (e: unknown) {
    error.value = (e as { message?: string })?.message ?? 'Failed to delete domain'
  } finally {
    deletingDomain.value = false
  }
}

const domainProjects = computed(() =>
  (domain.value?.routes ?? []).map((r) => r.project).filter((p) => !p.protected),
)

async function fetchDomain() {
  loading.value = true
  error.value = ''
  try {
    domain.value = await trpc.domains.get.query({ id: domainId })
    editSiteySubdomains.value = (domain.value as any).siteySubdomainsEnabled ?? false
    if (domain.value.status === 'error') {
      await loadCaddyLogs()
    } else {
      caddyLogLines.value = []
      caddyLogsError.value = ''
    }
  } catch (e: unknown) {
    error.value = (e as { message?: string })?.message ?? 'Failed to load domain'
  } finally {
    loading.value = false
  }
}

async function handleProjectCreated() {
  await fetchDomain()
}

function tlsLabel(status: string) {
  const labels: Record<string, string> = {
    pending: 'Obtaining certificate...',
    active: 'HTTPS active',
    error: 'Certificate error',
  }
  return labels[status] ?? status
}

function relativeTime(ts: string | Date) {
  const diff = Date.now() - new Date(ts).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

onMounted(async () => {
  await fetchDomain()
  checkDns()
})
</script>

<style scoped>
.breadcrumb {
  font-size: var(--font-tiny);
  color: var(--text-muted);
  margin-bottom: 0.5rem;
}

.breadcrumb a {
  color: var(--brand);
  text-decoration: none;
}

.breadcrumb a:hover {
  text-decoration: underline;
}

h1 {
  font-size: var(--font-huge);
  font-weight: 600;
  margin-bottom: 1.25rem;
}

.field-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.field-label {
  font-size: var(--font-tiny);
  color: var(--text-muted);
  min-width: 4rem;
}

.page-actions {
  display: flex;
  gap: 0.75rem;
  margin-bottom: 1.5rem;
}

.domain-section {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  margin-bottom: 2rem;
  max-width: 540px;
}

.section-title {
  font-size: var(--font-medium);
  font-weight: 600;
  margin-bottom: 1rem;
}

.project-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin-bottom: 2rem;
}

.project-card {
  background: var(--bg-card);
  border: 1px solid var(--border-default);
  border-radius: 10px;
  padding: 1rem 1.5rem;
  text-decoration: none;
  color: inherit;
  display: flex;
  align-items: center;
  justify-content: space-between;
  transition: border-color 0.15s;
}

.project-card:hover {
  border-color: var(--brand);
}

.project-name {
  font-weight: 600;
  margin-bottom: 0.2rem;
}

.project-repo {
  font-size: var(--font-tiny);
  color: var(--text-muted);
  font-family: monospace;
}

.project-right {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.last-deploy {
  font-size: var(--font-tiny);
  color: var(--text-muted);
}

.danger-zone {
  margin-top: 3rem;
  padding-top: 1.5rem;
  border-top: 1px solid var(--border-default);
}

.danger-zone h2 {
  font-size: var(--font-medium);
  font-weight: 600;
  margin-bottom: 0.5rem;
  color: var(--status-err-text);
}

.danger-desc {
  font-size: var(--font-tiny);
  color: var(--text-muted);
  margin-bottom: 1rem;
}

.status {
  font-size: var(--font-tiny);
  padding: 0.2rem 0.5rem;
  border-radius: 4px;
  font-weight: 500;
}

.status-idle {
  background: var(--status-idle-bg);
  color: var(--status-idle-text);
}

.status-pending {
  background: var(--status-warn-bg);
  color: var(--status-warn-text);
}

.status-building {
  background: var(--status-info-bg);
  color: var(--status-info-text);
}

.status-running {
  background: var(--status-ok-bg);
  color: var(--status-ok-text);
}

.status-active {
  background: var(--status-ok-bg);
  color: var(--status-ok-text);
}

.status-failed {
  background: var(--status-err-bg);
  color: var(--status-err-text);
}

.status-stopped {
  background: var(--status-idle-bg);
  color: var(--status-idle-text);
}

.status-error {
  background: var(--status-err-bg);
  color: var(--status-err-text);
}

.empty-state {
  color: var(--text-muted);
  padding: 2rem 0;
}

.mt-1 {
  margin-top: 1rem;
}

.state-msg {
  color: var(--text-muted);
}

.alert.error {
  background: var(--status-err-bg);
  border: 1px solid var(--status-err-border);
  color: var(--status-err-text);
  border-radius: 6px;
  padding: 0.6rem 0.75rem;
  font-size: var(--font-tiny);
  margin-bottom: 1rem;
}

.alert.success {
  background: var(--status-ok-bg);
  border: 1px solid var(--status-ok-text);
  color: var(--status-ok-text);
  border-radius: 6px;
  padding: 0.6rem 0.75rem;
  font-size: var(--font-tiny);
  margin-bottom: 1rem;
}


.btn-danger {
  background: var(--status-err-bg);
  color: var(--status-err-text);
  border: 1px solid var(--status-err-border);
  border-radius: 6px;
  padding: 0.6rem 1.25rem;
  font-size: var(--font-medium);
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s, border-color 0.15s;
}

.btn-danger:hover:not(:disabled) {
  border-color: #7c2323;
  opacity: 0.92;
}

.btn-danger:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.sitey-subdomain-row {
  align-items: center;
  gap: 1rem;
}

.checkbox-label {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 0.5rem;
  font-size: var(--font-tiny);
  color: var(--text-secondary);
  cursor: pointer;
}

.checkbox-label input[type="checkbox"] {
  width: 1rem;
  height: 1rem;
  accent-color: var(--brand);
  cursor: pointer;
  padding: 0;
  border: none;
}

.sitey-subdomain-link {
  font-size: var(--font-tiny);
  color: var(--brand);
  text-decoration: none;
  font-family: monospace;
}

.sitey-subdomain-link:hover {
  text-decoration: underline;
}

.dns-check {
  background: var(--bg-code);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  padding: 0.75rem 1rem;
}

.dns-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.dns-label {
  font-size: var(--font-tiny);
  color: var(--text-muted);
  font-family: monospace;
  flex: 1;
}

.dns-status {
  font-size: var(--font-tiny);
  white-space: nowrap;
}

.dns-checking {
  color: var(--text-muted);
}

.dns-ok {
  color: var(--status-ok-text);
}

.dns-fail {
  color: var(--status-err-text);
}

.btn-recheck {
  background: none;
  border: 1px solid var(--border-strong);
  color: var(--text-muted);
  border-radius: 4px;
  padding: 0.1rem 0.4rem;
  font-size: var(--font-tiny);
  cursor: pointer;
  line-height: 1.4;
  transition: border-color 0.15s, color 0.15s;
}

.btn-recheck:hover {
  border-color: var(--text-muted);
  color: var(--text-secondary);
}

.dns-hint {
  font-size: var(--font-tiny);
  color: var(--text-dim);
  margin-top: 0.4rem;
}

.tls-hint {
  margin: -0.35rem 0 0;
  font-size: var(--font-tiny);
  color: var(--text-muted);
  line-height: 1.45;
}

.caddy-logs {
  margin-top: -0.45rem;
}

.caddy-logs-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.45rem;
  font-size: var(--font-tiny);
  color: var(--text-secondary);
}

.caddy-logs-error {
  margin-bottom: 0.5rem;
}

.log-box {
  background: var(--bg-code);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  padding: 0.75rem;
  max-height: 260px;
  overflow-y: auto;
  font-family: monospace;
  font-size: var(--font-tiny);
  line-height: 1.5;
}

.log-content {
  color: #b0e0b0;
  white-space: pre-wrap;
  word-break: break-all;
}

.log-empty {
  color: var(--text-dim);
}

.btn-ghost-sm {
  background: none;
  color: var(--text-secondary);
  border: 1px solid var(--border-strong);
  border-radius: 5px;
  padding: 0.25rem 0.55rem;
  font-size: var(--font-tiny);
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}

.btn-ghost-sm:hover:not(:disabled) {
  border-color: var(--text-muted);
  color: var(--text-primary);
}

.btn-ghost-sm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>




