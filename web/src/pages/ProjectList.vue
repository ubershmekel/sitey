<template>
  <Layout>
    <div class="page-header">
      <h1>Projects</h1>
      <button class="btn-primary" @click="showAdd = true">+ New project</button>
    </div>

    <div v-if="loading" class="state-msg">Loading…</div>
    <div v-else-if="error" class="alert error">{{ error }}</div>

    <template v-else>
      <!-- Project grid -->
      <div v-if="userProjects.length > 0" class="project-grid">
        <RouterLink
          v-for="p in userProjects"
          :key="p.id"
          :to="`/projects/${p.id}`"
          class="project-card"
        >
          <div class="project-name">{{ p.name }}</div>
          <div class="project-meta">
            <span :class="`status status-${p.status}`">{{ p.status }}</span>
            <span class="deploy-mode">{{ p.deployMode }}</span>
          </div>
          <div class="project-routes">
            <span v-if="p.routes.length === 0" class="no-routes">no routes</span>
            <span v-for="r in p.routes" :key="r.id" class="route-tag">
              {{ routeLabel(r) }}
            </span>
          </div>
          <div class="project-repo">{{ p.repoOwner }}/{{ p.repoName }}</div>
        </RouterLink>
      </div>
    </template>

    <!-- Add project modal -->
    <div v-if="showAdd" class="modal-backdrop" @click.self="showAdd = false">
      <form class="modal" @submit.prevent="addProject">
        <h2>New project</h2>

        <div v-if="addError" class="alert error">{{ addError }}</div>

        <label>
          Name <span class="hint">(lowercase, hyphens only)</span>
          <input v-model="form.name" type="text" required placeholder="my-app" pattern="[a-z0-9-]+" />
        </label>
        <label>
          GitHub repository
          <input
            v-model="form.githubUrl"
            type="text"
            required
            list="repo-list"
            placeholder="owner/repo or https://github.com/owner/repo"
            @input="parseGithubUrl"
            @blur="parseGithubUrl"
          />
          <datalist id="repo-list">
            <option v-for="repo in appRepos" :key="repo.id" :value="repo.fullName" />
          </datalist>
          <span v-if="reposLoading" class="hint">Loading repos from GitHub App...</span>
          <span v-else-if="repoLoadError" class="hint">{{ repoLoadError }}</span>
          <span v-else-if="hasGitHubApp && appRepos.length > 0" class="hint">
            Autocomplete powered by your GitHub App repositories.
          </span>
          <span v-else-if="hasGitHubApp && repoInstallations === 0" class="hint">
            GitHub App is configured but not installed on any account or org yet.
            <a v-if="repoInstallUrl" :href="repoInstallUrl" target="_blank" rel="noopener">Install app</a>.
          </span>
          <span v-else-if="hasGitHubApp" class="hint">
            No repositories available from your GitHub App installation yet.
          </span>
        </label>
        <label>
          Branch
          <input v-model="form.branch" type="text" placeholder="main" list="branch-list" />
          <datalist id="branch-list">
            <option v-for="b in branches" :key="b" :value="b" />
          </datalist>
        </label>
        <label>
          Domain <span class="hint">(optional)</span>
          <select v-model="form.domainId">
            <option value="">No domain yet</option>
            <option v-for="d in domains" :key="d.id" :value="d.id">{{ d.hostname }}</option>
          </select>
        </label>
        <label>
          Build command <span class="hint">(optional)</span>
          <input v-model="form.buildCommand" type="text" placeholder="npm run build" />
        </label>
        <label>
          Output directory <span class="hint">(for static sites)</span>
          <input v-model="form.outputDir" type="text" placeholder="dist (leave empty for repo root)" />
        </label>
        <label>
          Server run command <span class="hint">(leave blank for a static site)</span>
          <input v-model="form.serverRunCommand" type="text" placeholder="node server.js" />
        </label>
        <label v-if="form.serverRunCommand">
          Container port
          <input v-model.number="form.containerPort" type="number" min="1" max="65535" required />
        </label>

        <div class="modal-actions">
          <button type="button" class="btn-ghost" @click="showAdd = false">Cancel</button>
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
import { RouterLink } from 'vue-router'
import Layout from '../components/Layout.vue'
import { trpc } from '../trpc'

type Project = Awaited<ReturnType<typeof trpc.projects.list.query>>[number]
type Route = Project['routes'][number]
type Domain = Awaited<ReturnType<typeof trpc.domains.list.query>>[number]
type AppRepo = Awaited<ReturnType<typeof trpc.github.listAppRepos.query>>['repos'][number]

const projects = ref<Project[]>([])
const loading = ref(true)
const error = ref('')
const showAdd = ref(false)
const adding = ref(false)
const addError = ref('')
const branches = ref<string[]>([])
const appRepos = ref<AppRepo[]>([])
const reposLoading = ref(false)
const repoLoadError = ref('')
const repoInstallations = ref(0)
const repoInstallUrl = ref('')
const domains = ref<Pick<Domain, 'id' | 'hostname'>[]>([])

const form = ref({
  name: '',
  githubUrl: '',
  repoOwner: '',
  repoName: '',
  domainId: '',
  branch: 'main',
  buildCommand: '',
  outputDir: '',
  serverRunCommand: '',
  containerPort: 3000,
})

const hasGitHubApp = ref(false)

const userProjects = computed(() => projects.value.filter(p => !p.protected))
const repoByFullName = computed(() => {
  return new Map(appRepos.value.map(repo => [repo.fullName.toLowerCase(), repo]))
})

function routeLabel(r: Route): string {
  const host = (() => {
    if (!r.domain?.hostname) return '<server>'
    if (!r.domain.hostname.startsWith('*.')) return r.domain.hostname
    return r.subdomain
      ? `${r.subdomain}.${r.domain.hostname.slice(2)}`
      : r.domain.hostname
  })()
  return r.pathPrefix ? `${host}${r.pathPrefix}` : host
}

function parseGithubUrl() {
  const val = form.value.githubUrl.trim()
  const match = val.match(/(?:github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?$/) ?? val.match(/^([^/]+)\/([^/]+)$/)
  if (match) {
    form.value.repoOwner = match[1]
    form.value.repoName = match[2]
    const selected = repoByFullName.value.get(`${match[1]}/${match[2]}`.toLowerCase())
    if (selected?.defaultBranch && (!form.value.branch.trim() || form.value.branch === 'main')) {
      form.value.branch = selected.defaultBranch
    }
    fetchBranches()
  }
}

async function fetchBranches() {
  const { repoOwner, repoName } = form.value
  if (!repoOwner || !repoName) return
  try {
    const res = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/branches?per_page=50`)
    if (res.ok) {
      const data = await res.json() as { name: string }[]
      branches.value = data.map(b => b.name)
    }
  } catch { /* ignore — field still works without autocomplete */ }
}

async function fetchAll() {
  loading.value = true
  error.value = ''
  try {
    const [projectList, domainList, appConfig] = await Promise.all([
      trpc.projects.list.query(),
      trpc.domains.list.query(),
      trpc.github.getAppConfig.query(),
    ])
    projects.value = projectList
    hasGitHubApp.value = appConfig.configured
    domains.value = domainList.map((d) => ({ id: d.id, hostname: d.hostname }))
  } catch (e: unknown) {
    error.value = (e as { message?: string })?.message ?? 'Failed to load'
  } finally {
    loading.value = false
  }
}

async function loadRepoSuggestions() {
  reposLoading.value = true
  repoLoadError.value = ''
  try {
    const res = await trpc.github.listAppRepos.query()
    appRepos.value = res.repos
    repoInstallations.value = res.installations
    repoInstallUrl.value = res.app.installUrl ?? ''
  } catch {
    appRepos.value = []
    repoInstallations.value = 0
    repoInstallUrl.value = ''
    repoLoadError.value = 'Could not load GitHub App repositories.'
  } finally {
    reposLoading.value = false
  }
}

const emptyForm = () => ({
  name: '', githubUrl: '', repoOwner: '', repoName: '', domainId: '',
  branch: 'main', buildCommand: '', outputDir: '', serverRunCommand: '', containerPort: 3000,
})

async function addProject() {
  addError.value = ''
  adding.value = true
  parseGithubUrl()
  try {
    const isStatic = !form.value.serverRunCommand.trim()
    const created = await trpc.projects.create.mutate({
      name: form.value.name.trim(),
      repoOwner: form.value.repoOwner.trim(),
      repoName: form.value.repoName.trim(),
      branch: form.value.branch.trim() || 'main',
      deployMode: isStatic ? 'static' : 'server',
      buildCommand: form.value.buildCommand.trim(),
      outputDir: form.value.outputDir.trim(),
      serverRunCommand: form.value.serverRunCommand.trim(),
      containerPort: form.value.containerPort,
    })
    if (form.value.domainId) {
      await trpc.projects.addRoute.mutate({
        projectId: created.id,
        domainId: form.value.domainId,
      })
    }
    showAdd.value = false
    form.value = emptyForm()
    branches.value = []
    await fetchAll()
  } catch (e: unknown) {
    addError.value = (e as { message?: string })?.message ?? 'Failed to create project'
  } finally {
    adding.value = false
  }
}

watch(showAdd, async (v) => {
  if (!v) {
    form.value = emptyForm()
    branches.value = []
    return
  }
  if (domains.value.length === 1) {
    form.value.domainId = domains.value[0].id
  }
  await loadRepoSuggestions()
})

onMounted(fetchAll)
</script>

<style scoped>
.page-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 2rem;
}
h1 { font-size: 1.4rem; font-weight: 600; }

/* ── Project grid ── */
.project-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1rem;
}

.project-card {
  background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 10px;
  padding: 1.25rem 1.5rem; text-decoration: none; color: inherit;
  transition: border-color 0.15s, background 0.15s;
  display: flex; flex-direction: column; gap: 0.6rem;
}
.project-card:hover { border-color: var(--brand); background: var(--bg-hover); }

.project-name { font-size: 1rem; font-weight: 600; color: var(--text-primary); }
.project-meta { display: flex; align-items: center; gap: 0.6rem; }
.deploy-mode { font-size: 0.75rem; color: var(--text-muted); background: var(--bg-input); border: 1px solid var(--border-strong); padding: 0.15rem 0.4rem; border-radius: 4px; }
.project-routes { display: flex; flex-wrap: wrap; gap: 0.35rem; }
.route-tag { font-size: 0.75rem; color: var(--brand); background: var(--brand-active-bg); border: 1px solid #3a3060; padding: 0.15rem 0.45rem; border-radius: 4px; }
.no-routes { font-size: 0.75rem; color: var(--text-dim); }
.project-repo { font-size: 0.78rem; color: var(--text-muted); margin-top: 0.15rem; }

.status { font-size: 0.75rem; padding: 0.2rem 0.5rem; border-radius: 4px; font-weight: 500; }
.status-idle     { background: var(--status-idle-bg);    color: var(--status-idle-text); }
.status-building { background: var(--status-queued-bg);  color: var(--brand); }
.status-running  { background: var(--status-ok-bg);      color: var(--status-ok-text); }
.status-failed   { background: var(--status-err-bg);     color: var(--status-err-text); }
.status-stopped  { background: var(--status-warn-bg);    color: var(--status-warn-text); }

.state-msg { color: var(--text-muted); }
.alert.error { background: var(--status-err-bg); border: 1px solid var(--status-err-border); color: var(--status-err-text); border-radius: 6px; padding: 0.6rem 0.75rem; font-size: 0.85rem; margin-bottom: 1rem; }

/* ── Modal ── */
.modal-backdrop {
  position: fixed; inset: 0; background: rgba(0,0,0,0.7);
  display: flex; align-items: center; justify-content: center; z-index: 100;
}
.modal {
  background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 12px;
  padding: 2rem; width: 440px; display: flex; flex-direction: column; gap: 1.25rem;
  max-height: 90vh; overflow-y: auto;
}
.modal h2 { font-size: 1.1rem; font-weight: 600; }
label { display: flex; flex-direction: column; gap: 0.4rem; font-size: 0.85rem; color: var(--text-secondary); }
.hint { color: var(--text-muted); font-size: 0.78rem; }
.hint a { color: var(--brand); }
input, select {
  background: var(--bg-input); border: 1px solid var(--border-strong); border-radius: 6px;
  padding: 0.6rem 0.75rem; color: var(--text-primary); font-size: 0.95rem; outline: none;
  transition: border-color 0.15s;
}
input:focus, select:focus { border-color: var(--brand); }
.modal-actions { display: flex; justify-content: flex-end; gap: 0.75rem; margin-top: 0.5rem; }

.btn-primary {
  background: var(--brand); color: #fff; border: none; border-radius: 6px;
  padding: 0.6rem 1.25rem; font-size: 0.9rem; font-weight: 600; cursor: pointer;
  transition: opacity 0.15s;
}
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-primary:hover:not(:disabled) { opacity: 0.85; }

.btn-ghost {
  background: none; color: var(--text-secondary); border: 1px solid var(--border-strong); border-radius: 6px;
  padding: 0.6rem 1.25rem; font-size: 0.9rem; cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}
.btn-ghost:hover { border-color: var(--text-muted); color: var(--text-primary); }
</style>
