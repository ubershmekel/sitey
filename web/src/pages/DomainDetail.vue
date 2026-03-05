<template>
  <Layout>
    <div v-if="loading" class="state-msg">Loading…</div>
    <div v-else-if="error" class="alert error">{{ error }}</div>
    <template v-else-if="domain">
      <div class="page-header">
        <div>
          <div class="breadcrumb"><RouterLink to="/">Domains</RouterLink> / {{ domain.hostname }}</div>
          <h1>{{ domain.hostname }}</h1>
        </div>
        <div class="header-actions">
          <span :class="`status status-${domain.status}`">{{ domain.status }}</span>
          <button class="btn-primary" @click="showAddProject = true">+ Add project</button>
        </div>
      </div>

      <div v-if="domain.projects.length === 0" class="empty-state">
        <p>No projects yet. Add one to deploy an app to this domain.</p>
        <button class="btn-primary mt-1" @click="showAddProject = true">Add project</button>
      </div>

      <div v-else class="project-list">
        <RouterLink
          v-for="p in domain.projects"
          :key="p.id"
          :to="`/projects/${p.id}`"
          class="project-card"
        >
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
          Repo owner / org
          <input v-model="np.repoOwner" required placeholder="acme-corp" />
        </label>
        <label>
          Repo name
          <input v-model="np.repoName" required placeholder="my-node-app" />
        </label>
        <label>
          Branch
          <input v-model="np.branch" required placeholder="main" />
        </label>
        <label>
          Subdomain <span class="hint">(leave blank to use root domain)</span>
          <input v-model="np.subdomain" placeholder="app" />
        </label>
        <label>
          Container port
          <input v-model.number="np.containerPort" type="number" min="1" max="65535" required />
        </label>

        <div class="form-row">
          <label style="flex:1">
            Build mode
            <select v-model="np.buildMode">
              <option value="auto">Auto (generate Dockerfile)</option>
              <option value="dockerfile">Use repo Dockerfile</option>
            </select>
          </label>
          <label style="flex:1">
            GitHub integration
            <select v-model="np.githubMode">
              <option value="webhook">Webhook</option>
              <option value="app">GitHub App</option>
            </select>
          </label>
        </div>

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
import { ref, onMounted, reactive } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import Layout from '../components/Layout.vue'
import { trpc } from '../trpc'

type Domain = Awaited<ReturnType<typeof trpc.domains.get.query>>

const route = useRoute()
const domainId = route.params.id as string

const domain = ref<Domain | null>(null)
const loading = ref(true)
const error = ref('')

const showAddProject = ref(false)
const adding = ref(false)
const addError = ref('')

const np = reactive({
  name: '',
  repoOwner: '',
  repoName: '',
  branch: 'main',
  subdomain: '',
  buildMode: 'auto' as 'auto' | 'dockerfile',
  containerPort: 3000,
  githubMode: 'webhook' as 'webhook' | 'app',
})

async function fetchDomain() {
  loading.value = true
  error.value = ''
  try {
    domain.value = await trpc.domains.get.query({ id: domainId })
  } catch (e: unknown) {
    error.value = (e as { message?: string })?.message ?? 'Failed to load domain'
  } finally {
    loading.value = false
  }
}

async function addProject() {
  addError.value = ''
  adding.value = true
  try {
    await trpc.projects.create.mutate({ ...np, domainId })
    showAddProject.value = false
    Object.assign(np, { name: '', repoOwner: '', repoName: '', branch: 'main', subdomain: '', containerPort: 3000 })
    await fetchDomain()
  } catch (e: unknown) {
    addError.value = (e as { message?: string })?.message ?? 'Failed to create project'
  } finally {
    adding.value = false
  }
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

onMounted(fetchDomain)
</script>

<style scoped>
.page-header {
  display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 2rem;
}
.breadcrumb { font-size: 0.8rem; color: #555; margin-bottom: 0.25rem; }
.breadcrumb a { color: #7c6cfc; text-decoration: none; }
.breadcrumb a:hover { text-decoration: underline; }
h1 { font-size: 1.4rem; font-weight: 600; }
.header-actions { display: flex; align-items: center; gap: 1rem; }

.project-list { display: flex; flex-direction: column; gap: 0.75rem; }
.project-card {
  background: #161616; border: 1px solid #2a2a2a; border-radius: 10px;
  padding: 1rem 1.5rem; text-decoration: none; color: inherit;
  display: flex; align-items: center; justify-content: space-between;
  transition: border-color 0.15s;
}
.project-card:hover { border-color: #7c6cfc; }
.project-name { font-weight: 600; margin-bottom: 0.2rem; }
.project-repo { font-size: 0.8rem; color: #666; font-family: monospace; }
.project-right { display: flex; align-items: center; gap: 1rem; }
.last-deploy { font-size: 0.8rem; color: #555; }

.status { font-size: 0.75rem; padding: 0.2rem 0.5rem; border-radius: 4px; font-weight: 500; }
.status-idle     { background: #1a1a1a; color: #666; }
.status-pending  { background: #2a2206; color: #d4a800; }
.status-building { background: #1a2a38; color: #60b4ff; }
.status-running  { background: #0e2a14; color: #40c060; }
.status-active   { background: #0e2a14; color: #40c060; }
.status-failed   { background: #2d1414; color: #ff6060; }
.status-stopped  { background: #1a1a1a; color: #666; }
.status-error    { background: #2d1414; color: #ff6060; }

.empty-state { color: #555; padding: 3rem 0; }
.mt-1 { margin-top: 1rem; }
.state-msg { color: #666; }
.alert.error {
  background: #2d1414; border: 1px solid #5a1a1a; color: #ff7070;
  border-radius: 6px; padding: 0.6rem 0.75rem; font-size: 0.85rem; margin-bottom: 1rem;
}

.modal-backdrop {
  position: fixed; inset: 0; background: rgba(0,0,0,0.7);
  display: flex; align-items: center; justify-content: center; z-index: 100;
}
.modal {
  background: #161616; border: 1px solid #2a2a2a; border-radius: 12px;
  padding: 2rem; width: 500px; max-height: 90vh; overflow-y: auto;
  display: flex; flex-direction: column; gap: 1rem;
}
.modal h2 { font-size: 1.1rem; font-weight: 600; }
label { display: flex; flex-direction: column; gap: 0.4rem; font-size: 0.85rem; color: #9a9a9a; }
.hint { color: #555; font-size: 0.78rem; }
.form-row { display: flex; gap: 1rem; }
input, select {
  background: #1f1f1f; border: 1px solid #333; border-radius: 6px;
  padding: 0.6rem 0.75rem; color: #e2e2e2; font-size: 0.9rem; outline: none;
  transition: border-color 0.15s;
}
input:focus, select:focus { border-color: #7c6cfc; }
.modal-actions { display: flex; justify-content: flex-end; gap: 0.75rem; margin-top: 0.5rem; }
.btn-primary {
  background: #7c6cfc; color: #fff; border: none; border-radius: 6px;
  padding: 0.6rem 1.25rem; font-size: 0.9rem; font-weight: 600; cursor: pointer;
  transition: opacity 0.15s;
}
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-primary:hover:not(:disabled) { opacity: 0.85; }
.btn-ghost {
  background: none; color: #9a9a9a; border: 1px solid #333; border-radius: 6px;
  padding: 0.6rem 1.25rem; font-size: 0.9rem; cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}
.btn-ghost:hover { border-color: #666; color: #e2e2e2; }
</style>
