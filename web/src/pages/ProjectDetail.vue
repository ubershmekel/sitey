<template>
  <Layout>
    <div v-if="loading" class="state-msg">Loading...</div>
    <div v-else-if="error" class="alert error">{{ error }}</div>
    <template v-else-if="project">
      <div class="page-header">
        <div>
          <div class="breadcrumb">
            <RouterLink to="/">Projects</RouterLink>
            <template v-if="primaryDomainRoute?.domain">
              /
              <RouterLink :to="`/domains/${primaryDomainRoute.domain.id}`">
                {{ primaryDomainRoute.domain.hostname }}
              </RouterLink>
            </template>
            / {{ project.name }}
          </div>
          <h1>{{ project.name }}</h1>
          <div v-if="projectUrl" class="project-url">
            <a :href="projectUrl" target="_blank" rel="noopener">{{ projectUrl }}</a>
            <span class="project-url-sep">·</span>
            <a :href="projectUrl.replace('https://', 'http://')" target="_blank" rel="noopener" class="url-http">http</a>
          </div>
          <div v-else-if="fallbackUrl" class="project-url hint">
            No domain route yet. Fallback: {{ fallbackUrl }}
          </div>
          <div v-else class="project-url hint">
            No route assigned yet.
          </div>
          <div v-if="project.status === 'failed'" class="deploy-notice deploy-notice-failed">
            Last deploy failed — site may be unavailable. Check logs below.
          </div>
          <div v-else-if="project.status === 'building' || project.status === 'queued'" class="deploy-notice deploy-notice-building">
            Deploy in progress — site will be available once it completes.
          </div>
        </div>
        <div class="header-actions">
          <span :class="`status status-${project.status}`">{{ project.status }}</span>
          <button class="btn-primary" :disabled="deploying" @click="triggerDeploy">
            {{ deploying ? 'Deploying...' : 'Deploy' }}
          </button>
          <button class="btn-danger" :disabled="deleting" @click="deleteProject">
            {{ deleting ? 'Deleting...' : 'Delete' }}
          </button>
        </div>
      </div>

      <div v-if="deployError" class="alert error">{{ deployError }}</div>

      <div class="info-grid">
        <div class="info-card">
          <div class="info-label">Repository</div>
          <div class="info-value mono">{{ project.repoOwner }}/{{ project.repoName }}:{{ project.branch }}</div>
        </div>
        <div class="info-card">
          <div class="info-label">Build mode</div>
          <div class="info-value">{{ project.buildMode === 'auto' ? 'Auto' : 'Dockerfile' }}</div>
        </div>
        <div class="info-card">
          <div class="info-label">Container port</div>
          <div class="info-value mono">{{ project.containerPort }}</div>
        </div>
        <div class="info-card">
          <div class="info-label">GitHub mode</div>
          <div class="info-value">{{ project.githubMode }}</div>
        </div>
        <div class="info-card">
          <div class="info-label">Routes</div>
          <div class="info-value mono">{{ project.routes.length }}</div>
        </div>
        <div class="info-card">
          <div class="info-label">Fallback port</div>
          <div class="info-value mono">{{ project.hostPort ?? '-' }}</div>
        </div>
      </div>

      <div class="section">
        <h2>Routes</h2>
        <div v-if="project.routes.length === 0" class="empty-msg">
          This project has no domain/path routes yet.
        </div>
        <div v-else class="route-list">
          <div v-for="r in project.routes" :key="r.id" class="route-row">
            <span class="route-url mono">{{ routeLabel(r) }}</span>
            <button
              class="btn-ghost-sm"
              :disabled="routeSaving || r.protected"
              @click="removeRoute(r.id)"
            >
              {{ r.protected ? 'Protected' : 'Remove' }}
            </button>
          </div>
        </div>

        <form class="route-form" @submit.prevent="addRoute">
          <label>
            Domain
            <select v-model="newRoute.domainId" required>
              <option value="">Select domain</option>
              <option v-for="d in domains" :key="d.id" :value="d.id">{{ d.hostname }}</option>
            </select>
          </label>
          <label>
            Path prefix <span class="hint">(optional, e.g. /blog)</span>
            <input v-model="newRoute.pathPrefix" type="text" placeholder="/" />
          </label>
          <button class="btn-primary" type="submit" :disabled="routeSaving || !newRoute.domainId">
            {{ routeSaving ? 'Saving...' : 'Add route' }}
          </button>
        </form>
        <div v-if="routeError" class="alert error mt-1">{{ routeError }}</div>
      </div>

      <div v-if="project.githubMode === 'webhook' && webhookInfo" class="webhook-card">
        <h2>GitHub Webhook Setup</h2>
        <p class="hint">Add this webhook in GitHub repo settings.</p>
        <div v-if="webhookInfo.domains.length > 1" class="webhook-row">
          <span class="wh-label">Domain</span>
          <select v-model="webhookDomainId" @change="refetchWebhookInfo" class="domain-select">
            <option v-for="d in webhookInfo.domains" :key="d.id" :value="d.id">{{ d.hostname }}</option>
          </select>
        </div>
        <div class="webhook-row">
          <span class="wh-label">Payload URL</span>
          <code>{{ webhookInfo.webhookUrl }}</code>
          <button class="btn-copy" @click="copy(webhookInfo.webhookUrl)">Copy</button>
        </div>
        <div class="webhook-row">
          <span class="wh-label">Secret</span>
          <code>{{ webhookInfo.webhookSecret }}</code>
          <button class="btn-copy" @click="copy(webhookInfo.webhookSecret ?? '')">Copy</button>
        </div>
        <button class="btn-ghost mt-1" @click="rotateSecret">Rotate secret</button>
      </div>

      <div class="section">
        <h2>Deployments</h2>
        <div v-if="project.deployments.length === 0" class="empty-msg">No deployments yet.</div>
        <div v-else class="deploy-list">
          <div
            v-for="d in project.deployments"
            :key="d.id"
            class="deploy-row"
            :class="{ active: selectedDeployId === d.id }"
            @click="selectDeploy(d.id)"
          >
            <span :class="`status status-${d.status}`">{{ d.status }}</span>
            <span class="deploy-sha mono">{{ d.commitSha?.slice(0, 8) ?? '-' }}</span>
            <span class="deploy-msg">{{ d.commitMessage?.slice(0, 60) ?? '' }}</span>
            <span class="deploy-time">{{ relativeTime(d.createdAt) }}</span>
            <span class="deploy-trigger">{{ d.triggeredBy }}</span>
          </div>
        </div>
      </div>

      <div v-if="selectedDeployId" class="log-section">
        <div class="log-header">
          <h3>Logs</h3>
          <button class="btn-ghost-sm" @click="refreshLogs">Refresh</button>
        </div>
        <div class="log-box" ref="logBox">
          <div v-if="logLines.length === 0" class="log-empty">No logs yet.</div>
          <pre v-else class="log-content">{{ logLines.join('\n') }}</pre>
        </div>
      </div>
    </template>
  </Layout>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import Layout from '../components/Layout.vue'
import { trpc } from '../trpc'

type Project = Awaited<ReturnType<typeof trpc.projects.get.query>>
type ProjectRoute = Project['routes'][number]
type WebhookInfo = Awaited<ReturnType<typeof trpc.projects.getWebhookInfo.query>>
type Domain = Awaited<ReturnType<typeof trpc.domains.list.query>>[number]

const route = useRoute()
const router = useRouter()
const projectId = route.params.id as string

const project = ref<Project | null>(null)
const domains = ref<Pick<Domain, 'id' | 'hostname'>[]>([])
const loading = ref(true)
const error = ref('')
const deploying = ref(false)
const deployError = ref('')
const deleting = ref(false)
const routeSaving = ref(false)
const routeError = ref('')
const webhookInfo = ref<WebhookInfo | null>(null)
const webhookDomainId = ref<string | null>(null)
const selectedDeployId = ref<string | null>(null)
const logLines = ref<string[]>([])
const logBox = ref<HTMLElement | null>(null)

const newRoute = ref({
  domainId: '',
  pathPrefix: '',
})

const primaryDomainRoute = computed(() =>
  project.value?.routes.find((r) => !!r.domain) ?? null,
)

function routeHostname(r: ProjectRoute): string {
  if (!r.domain?.hostname) return ''
  if (!r.domain.hostname.startsWith('*.')) return r.domain.hostname
  return r.subdomain
    ? `${r.subdomain}.${r.domain.hostname.slice(2)}`
    : r.domain.hostname
}

const projectUrl = computed(() => {
  const r = primaryDomainRoute.value
  if (!r?.domain) return ''
  return `https://${routeHostname(r)}${r.pathPrefix || ''}`
})

const fallbackUrl = computed(() => {
  if (!project.value?.hostPort) return ''
  return `http://<server-ip>:${project.value.hostPort}`
})

function normalizePathPrefix(input: string): string {
  const raw = input.trim()
  if (!raw || raw === '/') return ''
  return raw.startsWith('/') ? raw : `/${raw}`
}

function routeLabel(r: ProjectRoute): string {
  const pathPrefix = r.pathPrefix || ''
  const hostname = routeHostname(r)
  if (hostname) {
    return `https://${hostname}${pathPrefix}`
  }
  return pathPrefix ? `<server>${pathPrefix}` : '<server>'
}

async function fetchProject() {
  loading.value = true
  error.value = ''
  try {
    const [proj, domainList] = await Promise.all([
      trpc.projects.get.query({ id: projectId }),
      trpc.domains.list.query(),
    ])
    project.value = proj
    domains.value = domainList.map((d) => ({ id: d.id, hostname: d.hostname }))
    if (!newRoute.value.domainId && domains.value.length === 1) {
      newRoute.value.domainId = domains.value[0].id
    }

    if (project.value.githubMode === 'webhook') {
      await refetchWebhookInfo()
    } else {
      webhookInfo.value = null
      webhookDomainId.value = null
    }

    if (project.value.deployments[0]) {
      selectedDeployId.value = project.value.deployments[0].id
      await fetchLogs()
    } else {
      selectedDeployId.value = null
      logLines.value = []
    }
  } catch (e: unknown) {
    error.value = (e as { message?: string })?.message ?? 'Failed to load project'
  } finally {
    loading.value = false
  }
}

async function addRoute() {
  if (!newRoute.value.domainId) return
  routeSaving.value = true
  routeError.value = ''
  try {
    await trpc.projects.addRoute.mutate({
      projectId,
      domainId: newRoute.value.domainId,
      pathPrefix: normalizePathPrefix(newRoute.value.pathPrefix),
    })
    newRoute.value.pathPrefix = ''
    await fetchProject()
  } catch (e: unknown) {
    routeError.value = (e as { message?: string })?.message ?? 'Failed to add route'
  } finally {
    routeSaving.value = false
  }
}

async function removeRoute(routeId: string) {
  if (!confirm('Remove this route?')) return
  routeSaving.value = true
  routeError.value = ''
  try {
    await trpc.projects.removeRoute.mutate({ routeId })
    await fetchProject()
  } catch (e: unknown) {
    routeError.value = (e as { message?: string })?.message ?? 'Failed to remove route'
  } finally {
    routeSaving.value = false
  }
}

async function triggerDeploy() {
  deploying.value = true
  deployError.value = ''
  try {
    const res = await trpc.deploy.trigger.mutate({ projectId, triggeredBy: 'manual' })
    selectedDeployId.value = res.deploymentId
    await fetchProject()
  } catch (e: unknown) {
    deployError.value = (e as { message?: string })?.message ?? 'Deploy failed'
  } finally {
    deploying.value = false
  }
}

async function selectDeploy(id: string) {
  selectedDeployId.value = id
  await fetchLogs()
}

async function fetchLogs() {
  if (!selectedDeployId.value) return
  const res = await trpc.deploy.getLogs.query({ deploymentId: selectedDeployId.value })
  logLines.value = res.lines
  await nextTick()
  if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight
}

async function refreshLogs() {
  await fetchProject()
  await fetchLogs()
}

async function refetchWebhookInfo() {
  const info = await trpc.projects.getWebhookInfo.query({
    id: projectId,
    ...(webhookDomainId.value ? { domainId: webhookDomainId.value } : {}),
  })
  webhookInfo.value = info
  if (!webhookDomainId.value && info.domains.length === 1) {
    webhookDomainId.value = info.domains[0].id
  }
}

async function deleteProject() {
  if (!confirm(`Delete project "${project.value?.name}"? This will stop the container and remove all files.`)) return
  deleting.value = true
  try {
    await trpc.projects.delete.mutate({ id: projectId })
    router.push('/')
  } catch (e: unknown) {
    alert((e as { message?: string })?.message ?? 'Failed to delete project')
    deleting.value = false
  }
}

async function rotateSecret() {
  if (!confirm('Rotate webhook secret? You will need to update GitHub.')) return
  const res = await trpc.projects.rotateWebhookSecret.mutate({ id: projectId })
  if (webhookInfo.value) webhookInfo.value.webhookSecret = res.webhookSecret
}

function copy(text: string) {
  navigator.clipboard.writeText(text)
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

onMounted(fetchProject)
</script>

<style scoped>
.page-header {
  display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 2rem;
}
.breadcrumb { font-size: 0.8rem; color: var(--text-muted); margin-bottom: 0.25rem; }
.breadcrumb a { color: var(--brand); text-decoration: none; }
.breadcrumb a:hover { text-decoration: underline; }
h1 { font-size: 1.4rem; font-weight: 600; margin-bottom: 0.25rem; }
.project-url { font-size: 0.85rem; }
.project-url a { color: var(--brand); text-decoration: none; }
.project-url a:hover { text-decoration: underline; }
.project-url-sep { color: var(--text-dim); margin: 0 0.35rem; }
.url-http { color: var(--text-muted); font-size: 0.8rem; }
.deploy-notice { font-size: 0.78rem; margin-top: 0.3rem; padding: 0.2rem 0.5rem; border-radius: 4px; }
.deploy-notice-failed { background: var(--status-err-bg); color: var(--status-err-text); }
.deploy-notice-building { background: var(--status-info-bg); color: var(--status-info-text); }
.header-actions { display: flex; align-items: center; gap: 1rem; }

.info-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 1rem; margin-bottom: 2rem;
}
.info-card {
  background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 8px; padding: 1rem;
}
.info-label { font-size: 0.75rem; color: var(--text-muted); margin-bottom: 0.3rem; }
.info-value { font-size: 0.9rem; color: var(--text-primary); }
.mono { font-family: monospace; }

.section { margin-bottom: 2rem; }
.section h2 { font-size: 1rem; font-weight: 600; margin-bottom: 1rem; }
.empty-msg { color: var(--text-muted); font-size: 0.85rem; }

.route-list { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 1rem; }
.route-row {
  display: flex; align-items: center; justify-content: space-between; gap: 0.75rem;
  background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 6px; padding: 0.6rem 0.75rem;
}
.route-url { color: #b5d0ff; font-size: 0.82rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.route-form {
  display: grid; grid-template-columns: 1fr 1fr auto; gap: 0.75rem; align-items: end;
}

.webhook-card {
  background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 10px;
  padding: 1.5rem; margin-bottom: 2rem;
}
.webhook-card h2 { font-size: 1rem; font-weight: 600; margin-bottom: 0.5rem; }
.hint { font-size: 0.82rem; color: var(--text-muted); margin-bottom: 1rem; }
.webhook-row {
  display: flex; align-items: center; gap: 1rem;
  padding: 0.5rem 0; border-bottom: 1px solid var(--border-subtle);
}
.wh-label { font-size: 0.8rem; color: var(--text-muted); min-width: 100px; }
code { background: var(--bg-input); padding: 0.25rem 0.5rem; border-radius: 4px; font-family: monospace; font-size: 0.85rem; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.btn-copy {
  background: none; border: 1px solid var(--border-strong); color: var(--text-secondary); border-radius: 4px;
  padding: 0.2rem 0.5rem; font-size: 0.78rem; cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}
.btn-copy:hover { border-color: var(--text-muted); color: var(--text-primary); }

.deploy-list { display: flex; flex-direction: column; gap: 2px; }
.deploy-row {
  display: flex; align-items: center; gap: 1rem;
  padding: 0.6rem 1rem; border-radius: 6px; cursor: pointer;
  background: var(--bg-card); border: 1px solid var(--border-default); transition: border-color 0.15s;
}
.deploy-row:hover { border-color: var(--border-strong); }
.deploy-row.active { border-color: var(--brand); background: var(--bg-hover); }
.deploy-sha { font-family: monospace; font-size: 0.82rem; color: var(--text-muted); min-width: 70px; }
.deploy-msg { flex: 1; font-size: 0.85rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); }
.deploy-time { font-size: 0.78rem; color: var(--text-muted); white-space: nowrap; }
.deploy-trigger { font-size: 0.75rem; color: var(--text-muted); background: var(--bg-elevated); padding: 0.15rem 0.4rem; border-radius: 4px; }

.status { font-size: 0.75rem; padding: 0.2rem 0.5rem; border-radius: 4px; font-weight: 500; white-space: nowrap; }
.status-queued   { background: var(--status-queued-bg);  color: var(--status-queued-text); }
.status-building { background: var(--status-info-bg);    color: var(--status-info-text); }
.status-running  { background: var(--status-ok-bg);      color: var(--status-ok-text); }
.status-success  { background: var(--status-ok-bg);      color: var(--status-ok-text); }
.status-failed   { background: var(--status-err-bg);     color: var(--status-err-text); }
.status-idle     { background: var(--status-idle-bg);    color: var(--status-idle-text); }
.status-stopped  { background: var(--status-idle-bg);    color: var(--status-idle-text); }

.log-section { margin-top: 1.5rem; }
.log-header { display: flex; align-items: center; gap: 1rem; margin-bottom: 0.75rem; }
.log-header h3 { font-size: 0.95rem; font-weight: 600; }
.log-box {
  background: var(--bg-code); border: 1px solid var(--border-default); border-radius: 8px;
  padding: 1rem; max-height: 400px; overflow-y: auto; font-family: monospace;
  font-size: 0.8rem; line-height: 1.5;
}
.log-content { color: #b0e0b0; white-space: pre-wrap; word-break: break-all; }
.log-empty { color: var(--text-dim); }

.state-msg { color: var(--text-muted); }
.alert.error {
  background: var(--status-err-bg); border: 1px solid var(--status-err-border); color: var(--status-err-text);
  border-radius: 6px; padding: 0.6rem 0.75rem; font-size: 0.85rem;
}
.mt-1 { margin-top: 1rem; }

label { display: flex; flex-direction: column; gap: 0.4rem; font-size: 0.85rem; color: var(--text-secondary); }
input, select {
  background: var(--bg-input); border: 1px solid var(--border-strong); border-radius: 6px;
  padding: 0.6rem 0.75rem; color: var(--text-primary); font-size: 0.9rem; outline: none;
  transition: border-color 0.15s;
}
input:focus, select:focus { border-color: var(--brand); }

.btn-primary {
  background: var(--brand); color: #fff; border: none; border-radius: 6px;
  padding: 0.6rem 1.25rem; font-size: 0.9rem; font-weight: 600; cursor: pointer;
  transition: opacity 0.15s;
}
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-primary:hover:not(:disabled) { opacity: 0.85; }

.btn-danger {
  background: var(--status-err-bg); color: var(--status-err-text); border: 1px solid var(--status-err-border); border-radius: 6px;
  padding: 0.6rem 1.25rem; font-size: 0.9rem; font-weight: 600; cursor: pointer;
  transition: opacity 0.15s;
}
.btn-danger:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-danger:hover:not(:disabled) { background: #4a1a1a; border-color: #8a3030; }

.btn-ghost {
  background: none; color: var(--text-secondary); border: 1px solid var(--border-strong); border-radius: 6px;
  padding: 0.5rem 1rem; font-size: 0.85rem; cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}
.btn-ghost:hover { border-color: var(--text-muted); color: var(--text-primary); }
.btn-ghost-sm {
  background: none; color: var(--text-secondary); border: 1px solid var(--border-strong); border-radius: 5px;
  padding: 0.3rem 0.6rem; font-size: 0.8rem; cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}

.domain-select {
  background: var(--bg-input); border: 1px solid var(--border-strong); border-radius: 5px;
  padding: 0.3rem 0.5rem; color: var(--text-primary); font-size: 0.85rem; flex: 1;
}
</style>
