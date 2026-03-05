<template>
  <Layout>
    <div v-if="loading" class="state-msg">Loading…</div>
    <div v-else-if="error" class="alert error">{{ error }}</div>
    <template v-else-if="project">
      <!-- Header -->
      <div class="page-header">
        <div>
          <div class="breadcrumb">
            <RouterLink to="/">Domains</RouterLink> /
            <RouterLink :to="`/domains/${project.domainId}`">{{ project.domain.hostname }}</RouterLink> /
            {{ project.name }}
          </div>
          <h1>{{ project.name }}</h1>
          <div class="project-url">
            <a :href="`https://${projectUrl}`" target="_blank">{{ projectUrl }}</a>
          </div>
        </div>
        <div class="header-actions">
          <span :class="`status status-${project.status}`">{{ project.status }}</span>
          <button class="btn-primary" :disabled="deploying" @click="triggerDeploy">
            {{ deploying ? 'Deploying…' : '▶ Deploy' }}
          </button>
        </div>
      </div>

      <!-- Info grid -->
      <div class="info-grid">
        <div class="info-card">
          <div class="info-label">Repository</div>
          <div class="info-value mono">{{ project.repoOwner }}/{{ project.repoName }}:{{ project.branch }}</div>
        </div>
        <div class="info-card">
          <div class="info-label">Build mode</div>
          <div class="info-value">{{ project.buildMode === 'auto' ? 'Auto (generated Dockerfile)' : 'Repo Dockerfile' }}</div>
        </div>
        <div class="info-card">
          <div class="info-label">Container port</div>
          <div class="info-value mono">{{ project.containerPort }}</div>
        </div>
        <div class="info-card">
          <div class="info-label">GitHub mode</div>
          <div class="info-value">{{ project.githubMode }}</div>
        </div>
      </div>

      <!-- Webhook info (if webhook mode) -->
      <div v-if="project.githubMode === 'webhook' && webhookInfo" class="webhook-card">
        <h2>GitHub Webhook Setup</h2>
        <p class="hint">Add this webhook to your GitHub repo settings → Webhooks → Add webhook.</p>
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
        <div class="webhook-row">
          <span class="wh-label">Content type</span>
          <code>application/json</code>
        </div>
        <div class="webhook-row">
          <span class="wh-label">Events</span>
          <code>push</code>
        </div>
        <button class="btn-ghost mt-1" @click="rotateSecret">Rotate secret</button>
      </div>

      <!-- Deployments -->
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
            <span class="deploy-sha mono">{{ d.commitSha?.slice(0, 8) ?? '—' }}</span>
            <span class="deploy-msg">{{ d.commitMessage?.slice(0, 60) ?? '' }}</span>
            <span class="deploy-time">{{ relativeTime(d.createdAt) }}</span>
            <span class="deploy-trigger">{{ d.triggeredBy }}</span>
          </div>
        </div>
      </div>

      <!-- Log viewer -->
      <div v-if="selectedDeployId" class="log-section">
        <div class="log-header">
          <h3>Logs</h3>
          <button class="btn-ghost-sm" @click="refreshLogs">↻ Refresh</button>
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
import { useRoute, RouterLink } from 'vue-router'
import Layout from '../components/Layout.vue'
import { trpc } from '../trpc'

type Project = Awaited<ReturnType<typeof trpc.projects.get.query>>
type WebhookInfo = Awaited<ReturnType<typeof trpc.projects.getWebhookInfo.query>>

const route = useRoute()
const projectId = route.params.id as string

const project = ref<Project | null>(null)
const loading = ref(true)
const error = ref('')
const deploying = ref(false)
const deployError = ref('')
const webhookInfo = ref<WebhookInfo | null>(null)
const selectedDeployId = ref<string | null>(null)
const logLines = ref<string[]>([])
const logBox = ref<HTMLElement | null>(null)

const projectUrl = computed(() => {
  if (!project.value) return ''
  const h = project.value.domain.hostname
  return project.value.subdomain ? `${project.value.subdomain}.${h}` : h
})

async function fetchProject() {
  loading.value = true
  error.value = ''
  try {
    project.value = await trpc.projects.get.query({ id: projectId })
    if (project.value.githubMode === 'webhook') {
      webhookInfo.value = await trpc.projects.getWebhookInfo.query({ id: projectId })
    }
    if (project.value.deployments[0]) {
      selectedDeployId.value = project.value.deployments[0].id
      await fetchLogs()
    }
  } catch (e: unknown) {
    error.value = (e as { message?: string })?.message ?? 'Failed to load project'
  } finally {
    loading.value = false
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
.breadcrumb { font-size: 0.8rem; color: #555; margin-bottom: 0.25rem; }
.breadcrumb a { color: #7c6cfc; text-decoration: none; }
.breadcrumb a:hover { text-decoration: underline; }
h1 { font-size: 1.4rem; font-weight: 600; margin-bottom: 0.25rem; }
.project-url a { font-size: 0.85rem; color: #7c6cfc; text-decoration: none; }
.project-url a:hover { text-decoration: underline; }
.header-actions { display: flex; align-items: center; gap: 1rem; }

.info-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 1rem; margin-bottom: 2rem;
}
.info-card {
  background: #161616; border: 1px solid #2a2a2a; border-radius: 8px; padding: 1rem;
}
.info-label { font-size: 0.75rem; color: #555; margin-bottom: 0.3rem; }
.info-value { font-size: 0.9rem; color: #e2e2e2; }
.mono { font-family: monospace; }

.webhook-card {
  background: #161616; border: 1px solid #2a2a2a; border-radius: 10px;
  padding: 1.5rem; margin-bottom: 2rem;
}
.webhook-card h2 { font-size: 1rem; font-weight: 600; margin-bottom: 0.5rem; }
.hint { font-size: 0.82rem; color: #666; margin-bottom: 1rem; }
.webhook-row {
  display: flex; align-items: center; gap: 1rem;
  padding: 0.5rem 0; border-bottom: 1px solid #1e1e1e;
}
.wh-label { font-size: 0.8rem; color: #666; min-width: 100px; }
code { background: #1f1f1f; padding: 0.25rem 0.5rem; border-radius: 4px; font-family: monospace; font-size: 0.85rem; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.btn-copy {
  background: none; border: 1px solid #333; color: #9a9a9a; border-radius: 4px;
  padding: 0.2rem 0.5rem; font-size: 0.78rem; cursor: pointer;
}
.btn-copy:hover { border-color: #666; color: #e2e2e2; }
.mt-1 { margin-top: 1rem; }

.section { margin-bottom: 2rem; }
.section h2 { font-size: 1rem; font-weight: 600; margin-bottom: 1rem; }
.empty-msg { color: #555; font-size: 0.85rem; }

.deploy-list { display: flex; flex-direction: column; gap: 2px; }
.deploy-row {
  display: flex; align-items: center; gap: 1rem;
  padding: 0.6rem 1rem; border-radius: 6px; cursor: pointer;
  background: #161616; border: 1px solid #2a2a2a; transition: border-color 0.15s;
}
.deploy-row:hover { border-color: #444; }
.deploy-row.active { border-color: #7c6cfc; background: #1a1a28; }
.deploy-sha { font-family: monospace; font-size: 0.82rem; color: #888; min-width: 70px; }
.deploy-msg { flex: 1; font-size: 0.85rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #ccc; }
.deploy-time { font-size: 0.78rem; color: #555; white-space: nowrap; }
.deploy-trigger { font-size: 0.75rem; color: #555; background: #1a1a1a; padding: 0.15rem 0.4rem; border-radius: 4px; }

.status { font-size: 0.75rem; padding: 0.2rem 0.5rem; border-radius: 4px; font-weight: 500; white-space: nowrap; }
.status-queued   { background: #1a1a2a; color: #9090ff; }
.status-building { background: #1a2a38; color: #60b4ff; }
.status-running  { background: #1a2a38; color: #60b4ff; }
.status-success  { background: #0e2a14; color: #40c060; }
.status-failed   { background: #2d1414; color: #ff6060; }
.status-idle     { background: #1a1a1a; color: #666; }
.status-stopped  { background: #1a1a1a; color: #666; }

.log-section { margin-top: 1.5rem; }
.log-header { display: flex; align-items: center; gap: 1rem; margin-bottom: 0.75rem; }
.log-header h3 { font-size: 0.95rem; font-weight: 600; }
.log-box {
  background: #0a0a0a; border: 1px solid #2a2a2a; border-radius: 8px;
  padding: 1rem; max-height: 400px; overflow-y: auto; font-family: monospace;
  font-size: 0.8rem; line-height: 1.5;
}
.log-content { color: #b0e0b0; white-space: pre-wrap; word-break: break-all; }
.log-empty { color: #444; }

.state-msg { color: #666; }
.alert.error {
  background: #2d1414; border: 1px solid #5a1a1a; color: #ff7070;
  border-radius: 6px; padding: 0.6rem 0.75rem; font-size: 0.85rem;
}

.btn-primary {
  background: #7c6cfc; color: #fff; border: none; border-radius: 6px;
  padding: 0.6rem 1.25rem; font-size: 0.9rem; font-weight: 600; cursor: pointer;
  transition: opacity 0.15s;
}
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-primary:hover:not(:disabled) { opacity: 0.85; }

.btn-ghost {
  background: none; color: #9a9a9a; border: 1px solid #333; border-radius: 6px;
  padding: 0.5rem 1rem; font-size: 0.85rem; cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}
.btn-ghost:hover { border-color: #666; color: #e2e2e2; }
.btn-ghost-sm {
  background: none; color: #9a9a9a; border: 1px solid #333; border-radius: 5px;
  padding: 0.3rem 0.6rem; font-size: 0.8rem; cursor: pointer;
}
</style>
