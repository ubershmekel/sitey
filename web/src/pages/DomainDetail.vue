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
        <button class="btn-primary" :disabled="editSaving" @click="saveEdit">
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

        <label>
          Let's Encrypt email
          <input v-model="editEmail" type="email" />
        </label>

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

    <!-- Add project modal -->
    <div v-if="showAddProject" class="modal-backdrop" @click.self="showAddProject = false">
      <form class="modal" @submit.prevent="addProject">
        <h2>Add project</h2>
        <div v-if="addError" class="alert error">{{ addError }}</div>

        <label>
          Project name <span class="hint">(lowercase, hyphens only)</span>
          <input v-model="np.name" type="text" required placeholder="my-app" pattern="[a-z0-9\-]+" />
        </label>
        <label>
          GitHub repository
          <input v-model="np.githubUrl" type="text" required list="domain-repo-list"
            placeholder="owner/repo or https://github.com/owner/repo" @input="parseGithubUrl" @blur="parseGithubUrl" />
          <datalist id="domain-repo-list">
            <option v-for="repo in appRepos" :key="repo.id" :value="repo.fullName" />
          </datalist>
          <span v-if="reposLoading" class="hint">Loading repos from GitHub App...</span>
          <span v-else-if="repoLoadError" class="hint">{{ repoLoadError }}</span>
          <span v-else-if="reposConfigured && appRepos.length > 0" class="hint">
            Autocomplete powered by your GitHub App repositories.
          </span>
          <span v-else-if="reposConfigured && repoInstallations === 0" class="hint">
            GitHub App is configured but not installed on any account or org yet.
            <a v-if="repoInstallUrl" :href="repoInstallUrl" target="_blank" rel="noopener">Install app</a>.
          </span>
          <span v-else-if="reposConfigured" class="hint">
            No repositories available from your GitHub App installation yet.
          </span>
        </label>
        <label>
          Branch
          <input v-model="np.branch" type="text" placeholder="main" list="dd-branch-list" />
          <datalist id="dd-branch-list">
            <option v-for="b in branches" :key="b" :value="b" />
          </datalist>
        </label>

        <label>
          Build command <span class="hint">(optional)</span>
          <input v-model="np.buildCommand" type="text" placeholder="npm run build" />
        </label>
        <label>
          Output directory <span class="hint">(for static sites)</span>
          <input v-model="np.outputDir" type="text" placeholder="dist (leave empty for repo root)" />
        </label>
        <label>
          Server run command <span class="hint">(leave blank for a static site)</span>
          <input v-model="np.serverRunCommand" type="text" placeholder="node server.js" />
        </label>
        <label v-if="np.serverRunCommand">
          Container port
          <input v-model.number="np.containerPort" type="number" min="1" max="65535" required />
        </label>

        <div class="modal-actions">
          <button type="button" class="btn-ghost" @click="showAddProject = false">Cancel</button>
          <button type="submit" class="btn-primary" :disabled="adding">
            {{ adding ? 'Creating…' : 'Create project' }}
          </button>
        </div>
      </form>
    </div>
  </Layout>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import Layout from '../components/Layout.vue'
import { trpc } from '../trpc'

type Domain = Awaited<ReturnType<typeof trpc.domains.get.query>>
type AppRepo = Awaited<ReturnType<typeof trpc.github.listAppRepos.query>>['repos'][number]

const route = useRoute()
const router = useRouter()
const domainId = Number(route.params.id)

const domain = ref<Domain | null>(null)
const loading = ref(true)
const error = ref('')

const showAddProject = ref(false)
const adding = ref(false)
const addError = ref('')
const branches = ref<string[]>([])
const appRepos = ref<AppRepo[]>([])
const reposLoading = ref(false)
const reposConfigured = ref(false)
const repoLoadError = ref('')
const repoInstallations = ref(0)
const repoInstallUrl = ref('')

// ── Inline domain edit ────────────────────────────────────────────────────────
const editEmail = ref('')
const editSiteySubdomains = ref(false)
const editSaving = ref(false)
const editError = ref('')
const saveSucceeded = ref(false)
const deletingDomain = ref(false)

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
      letsEncryptEmail: editEmail.value,
      ...(isWildcard.value ? { siteySubdomainsEnabled: editSiteySubdomains.value } : {}),
    })
    saveSucceeded.value = true
    setTimeout(() => { saveSucceeded.value = false }, 3000)
    await fetchDomain()
  } catch (e: unknown) {
    editError.value = (e as { message?: string })?.message ?? 'Failed to save'
  } finally {
    editSaving.value = false
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
  (domain.value?.routes ?? [])
    .map(r => r.project)
    .filter(p => !p.protected),
)

const emptyForm = () => ({
  name: '',
  githubUrl: '',
  repoOwner: '',
  repoName: '',
  branch: 'main',
  buildCommand: '',
  outputDir: '',
  serverRunCommand: '',
  containerPort: 3000,
})

const np = ref(emptyForm())
const repoByFullName = computed(() => {
  return new Map(appRepos.value.map(repo => [repo.fullName.toLowerCase(), repo]))
})

async function fetchDomain() {
  loading.value = true
  error.value = ''
  try {
    domain.value = await trpc.domains.get.query({ id: domainId })
    editEmail.value = domain.value.letsEncryptEmail ?? ''
    editSiteySubdomains.value = (domain.value as any).siteySubdomainsEnabled ?? false
  } catch (e: unknown) {
    error.value = (e as { message?: string })?.message ?? 'Failed to load domain'
  } finally {
    loading.value = false
  }
}

function parseGithubUrl() {
  const val = np.value.githubUrl.trim()
  const match = val.match(/(?:github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?$/) ?? val.match(/^([^/]+)\/([^/]+)$/)
  if (match) {
    np.value.repoOwner = match[1]
    np.value.repoName = match[2]
    const selected = repoByFullName.value.get(`${match[1]}/${match[2]}`.toLowerCase())
    if (selected?.defaultBranch && (!np.value.branch.trim() || np.value.branch === 'main')) {
      np.value.branch = selected.defaultBranch
    }
    fetchBranches()
  }
}

async function fetchBranches() {
  const { repoOwner, repoName } = np.value
  if (!repoOwner || !repoName) return
  try {
    const res = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/branches?per_page=50`)
    if (res.ok) {
      const data = await res.json() as { name: string }[]
      branches.value = data.map(b => b.name)
    }
  } catch { /* ignore */ }
}

async function loadRepoSuggestions() {
  reposLoading.value = true
  repoLoadError.value = ''
  try {
    const res = await trpc.github.listAppRepos.query()
    appRepos.value = res.repos
    reposConfigured.value = res.configured
    repoInstallations.value = res.installations
    repoInstallUrl.value = res.app.installUrl ?? ''
  } catch {
    appRepos.value = []
    reposConfigured.value = false
    repoInstallations.value = 0
    repoInstallUrl.value = ''
    repoLoadError.value = 'Could not load GitHub App repositories.'
  } finally {
    reposLoading.value = false
  }
}

async function addProject() {
  addError.value = ''
  adding.value = true
  parseGithubUrl()
  try {
    const isStatic = !np.value.serverRunCommand.trim()
    const project = await trpc.projects.create.mutate({
      name: np.value.name.trim(),
      repoOwner: np.value.repoOwner.trim(),
      repoName: np.value.repoName.trim(),
      branch: np.value.branch.trim() || 'main',
      deployMode: isStatic ? 'static' : 'server',
      buildCommand: np.value.buildCommand.trim(),
      outputDir: np.value.outputDir.trim(),
      serverRunCommand: np.value.serverRunCommand.trim(),
      buildMode: 'auto',
      containerPort: np.value.containerPort,
    })
    await trpc.projects.addRoute.mutate({ projectId: project.id, domainId })
    showAddProject.value = false
    np.value = emptyForm()
    branches.value = []
    await fetchDomain()
  } catch (e: unknown) {
    addError.value = (e as { message?: string })?.message ?? 'Failed to create project'
  } finally {
    adding.value = false
  }
}

function tlsLabel(status: string) {
  const labels: Record<string, string> = {
    pending: 'Obtaining certificate…',
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

watch(showAddProject, async (v) => {
  if (!v) {
    np.value = emptyForm()
    branches.value = []
    return
  }
  await loadRepoSuggestions()
})

onMounted(async () => {
  await fetchDomain()
  checkDns()
})
</script>

<style scoped>
.breadcrumb {
  font-size: 0.8rem;
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
  font-size: 1.4rem;
  font-weight: 600;
  margin-bottom: 1.25rem;
}

.field-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.field-label {
  font-size: 0.8rem;
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
  font-size: 1rem;
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
  font-size: 0.8rem;
  color: var(--text-muted);
  font-family: monospace;
}

.project-right {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.last-deploy {
  font-size: 0.8rem;
  color: var(--text-muted);
}

.danger-zone {
  margin-top: 3rem;
  padding-top: 1.5rem;
  border-top: 1px solid var(--border-default);
}

.danger-zone h2 {
  font-size: 1rem;
  font-weight: 600;
  margin-bottom: 0.5rem;
  color: var(--status-err-text);
}

.danger-desc {
  font-size: 0.85rem;
  color: var(--text-muted);
  margin-bottom: 1rem;
}

.status {
  font-size: 0.75rem;
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
  font-size: 0.85rem;
  margin-bottom: 1rem;
}

.alert.success {
  background: var(--status-ok-bg);
  border: 1px solid var(--status-ok-text);
  color: var(--status-ok-text);
  border-radius: 6px;
  padding: 0.6rem 0.75rem;
  font-size: 0.85rem;
  margin-bottom: 1rem;
}

.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.modal {
  background: var(--bg-card);
  border: 1px solid var(--border-default);
  border-radius: 12px;
  padding: 2rem;
  width: 500px;
  max-height: 90vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.modal h2 {
  font-size: 1.1rem;
  font-weight: 600;
}

label {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  font-size: 0.85rem;
  color: var(--text-secondary);
}

.hint {
  color: var(--text-muted);
  font-size: 0.78rem;
}

.hint a {
  color: var(--brand);
}

input,
select {
  background: var(--bg-input);
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  padding: 0.6rem 0.75rem;
  color: var(--text-primary);
  font-size: 0.9rem;
  outline: none;
  transition: border-color 0.15s;
}

input:focus,
select:focus {
  border-color: var(--brand);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  margin-top: 0.5rem;
}

.btn-primary {
  background: var(--brand);
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 0.6rem 1.25rem;
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-primary:hover:not(:disabled) {
  opacity: 0.85;
}

.btn-ghost {
  background: none;
  color: var(--text-secondary);
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  padding: 0.6rem 1.25rem;
  font-size: 0.9rem;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}

.btn-ghost:hover {
  border-color: var(--text-muted);
  color: var(--text-primary);
}

.btn-danger {
  background: var(--status-err-bg);
  color: var(--status-err-text);
  border: 1px solid var(--status-err-border);
  border-radius: 6px;
  padding: 0.6rem 1.25rem;
  font-size: 0.9rem;
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
  font-size: 0.85rem;
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
  font-size: 0.8rem;
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
  font-size: 0.85rem;
  color: var(--text-muted);
  font-family: monospace;
  flex: 1;
}

.dns-status {
  font-size: 0.8rem;
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
  font-size: 0.8rem;
  cursor: pointer;
  line-height: 1.4;
  transition: border-color 0.15s, color 0.15s;
}

.btn-recheck:hover {
  border-color: var(--text-muted);
  color: var(--text-secondary);
}

.dns-hint {
  font-size: 0.78rem;
  color: var(--text-dim);
  margin-top: 0.4rem;
}
</style>
