<template>
  <Layout>
    <div class="page-header">
      <h1>Projects</h1>
      <button class="btn-primary" @click="showAdd = true">+ New project</button>
    </div>

    <div v-if="loading" class="state-msg">Loading…</div>
    <div v-else-if="error" class="alert error">{{ error }}</div>

    <template v-else>
      <!-- Onboarding checklist -->
      <div v-if="!onboardingDone" class="onboarding">
        <h2 class="onboarding-title">Getting started</h2>

        <!-- Step 1: Domain -->
        <div class="step" :class="{ done: hasDomain }">
          <div class="step-check">{{ hasDomain ? '✓' : '1' }}</div>
          <div class="step-body">
            <div class="step-heading">Set up a domain</div>
            <div class="step-desc">
              Add the domain you own and point its DNS A record to this server's IP.
              For wildcard subdomains, also add a <code>*</code> A record.
            </div>
          </div>
          <RouterLink to="/domains" class="step-action">
            {{ hasDomain ? 'Manage domains' : 'Go to Domains →' }}
          </RouterLink>
        </div>

        <!-- Step 2: GitHub App -->
        <div class="step" :class="{ done: hasGitHubApp }">
          <div class="step-check">{{ hasGitHubApp ? '✓' : '2' }}</div>
          <div class="step-body">
            <div class="step-heading">Connect GitHub</div>
            <div class="step-desc">
              Create a GitHub App so Sitey can clone your repos and receive push webhooks.
              Go to Settings and click <strong>Create GitHub App automatically</strong> — Sitey will
              pre-fill everything and create the app in one click.
            </div>
          </div>
          <RouterLink to="/settings" class="step-action">
            {{ hasGitHubApp ? 'Manage in Settings' : 'Go to Settings →' }}
          </RouterLink>
        </div>

        <!-- Step 3: Project -->
        <div class="step" :class="{ done: hasProject }">
          <div class="step-check">{{ hasProject ? '✓' : '3' }}</div>
          <div class="step-body">
            <div class="step-heading">Create your first project</div>
            <div class="step-desc">
              Connect a GitHub repository to a domain and deploy it.
            </div>
          </div>
          <button class="step-action btn-step" @click="showAdd = true">
            {{ hasProject ? 'New project' : 'Create project →' }}
          </button>
        </div>
      </div>

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
            placeholder="owner/repo or https://github.com/owner/repo"
            @blur="parseGithubUrl"
          />
        </label>
        <label>
          Branch
          <input v-model="form.branch" type="text" placeholder="main" list="branch-list" />
          <datalist id="branch-list">
            <option v-for="b in branches" :key="b" :value="b" />
          </datalist>
        </label>
        <label>
          Build command <span class="hint">(optional)</span>
          <input v-model="form.buildCommand" type="text" placeholder="npm run build" />
        </label>
        <label>
          Output directory <span class="hint">(for static sites)</span>
          <input v-model="form.outputDir" type="text" placeholder="dist" />
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

const projects = ref<Project[]>([])
const loading = ref(true)
const error = ref('')
const showAdd = ref(false)
const adding = ref(false)
const addError = ref('')
const branches = ref<string[]>([])

const hasDomain = ref(false)
const hasGitHubApp = ref(false)

const form = ref({
  name: '',
  githubUrl: '',
  repoOwner: '',
  repoName: '',
  branch: 'main',
  buildCommand: '',
  outputDir: 'dist',
  serverRunCommand: '',
  containerPort: 3000,
})

const userProjects = computed(() => projects.value.filter(p => !p.protected))
const hasProject = computed(() => userProjects.value.length > 0)
const onboardingDone = computed(() => hasDomain.value && hasGitHubApp.value && hasProject.value)

function routeLabel(r: Route): string {
  const host = r.domain?.hostname ?? '<server>'
  return r.pathPrefix ? `${host}${r.pathPrefix}` : host
}

function parseGithubUrl() {
  const val = form.value.githubUrl.trim()
  const match = val.match(/(?:github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?$/) ?? val.match(/^([^/]+)\/([^/]+)$/)
  if (match) {
    form.value.repoOwner = match[1]
    form.value.repoName = match[2]
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
    hasDomain.value = domainList.length > 0
    hasGitHubApp.value = appConfig.configured
  } catch (e: unknown) {
    error.value = (e as { message?: string })?.message ?? 'Failed to load'
  } finally {
    loading.value = false
  }
}

const emptyForm = () => ({
  name: '', githubUrl: '', repoOwner: '', repoName: '',
  branch: 'main', buildCommand: '', outputDir: 'dist', serverRunCommand: '', containerPort: 3000,
})

async function addProject() {
  addError.value = ''
  adding.value = true
  parseGithubUrl()
  try {
    const isStatic = !form.value.serverRunCommand.trim()
    await trpc.projects.create.mutate({
      name: form.value.name.trim(),
      repoOwner: form.value.repoOwner.trim(),
      repoName: form.value.repoName.trim(),
      branch: form.value.branch.trim() || 'main',
      deployMode: isStatic ? 'static' : 'server',
      buildCommand: form.value.buildCommand.trim(),
      outputDir: form.value.outputDir.trim() || 'dist',
      serverRunCommand: form.value.serverRunCommand.trim(),
      containerPort: form.value.containerPort,
    })
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

watch(showAdd, (v) => { if (!v) { form.value = emptyForm(); branches.value = [] } })

onMounted(fetchAll)
</script>

<style scoped>
.page-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 2rem;
}
h1 { font-size: 1.4rem; font-weight: 600; }

/* ── Onboarding ── */
.onboarding {
  background: #161616; border: 1px solid #2a2a2a; border-radius: 12px;
  padding: 1.5rem; margin-bottom: 2rem;
}
.onboarding-title { font-size: 0.95rem; font-weight: 600; color: #888; margin-bottom: 1rem; text-transform: uppercase; letter-spacing: 0.05em; }

.step {
  display: flex; align-items: flex-start; gap: 1rem;
  padding: 1rem 0; border-bottom: 1px solid #1e1e1e;
}
.step:last-child { border-bottom: none; padding-bottom: 0; }
.step.done { opacity: 0.45; }

.step-check {
  width: 28px; height: 28px; border-radius: 50%;
  background: #1f1f1f; border: 2px solid #333;
  display: flex; align-items: center; justify-content: center;
  font-size: 0.78rem; font-weight: 700; color: #777; flex-shrink: 0; margin-top: 2px;
}
.step.done .step-check {
  background: #0e2a14; border-color: #2a5a30; color: #40c060;
}

.step-body { flex: 1; }
.step-heading { font-size: 0.95rem; font-weight: 600; color: #e2e2e2; margin-bottom: 0.35rem; }
.step-desc { font-size: 0.82rem; color: #666; line-height: 1.55; }
.step-desc code { background: #1f1f1f; border-radius: 3px; padding: 0.1em 0.35em; font-size: 0.9em; color: #9dcfff; }
.step-instructions { margin: 0.6rem 0 0 1.2rem; padding: 0; display: flex; flex-direction: column; gap: 0.25rem; }
.step-instructions li { font-size: 0.82rem; color: #666; }
.step-instructions strong { color: #aaa; }
.step-instructions em { color: #888; }

.step-action {
  font-size: 0.82rem; color: #7c6cfc; text-decoration: none; white-space: nowrap;
  padding: 0.35rem 0; flex-shrink: 0; align-self: flex-start; margin-top: 2px;
}
.step-action:hover { text-decoration: underline; }
.btn-step {
  background: none; border: none; cursor: pointer;
  font-size: 0.82rem; color: #7c6cfc; padding: 0.35rem 0; white-space: nowrap;
}
.btn-step:hover { text-decoration: underline; }

/* ── Project grid ── */
.project-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1rem;
}

.project-card {
  background: #161616; border: 1px solid #2a2a2a; border-radius: 10px;
  padding: 1.25rem 1.5rem; text-decoration: none; color: inherit;
  transition: border-color 0.15s, background 0.15s;
  display: flex; flex-direction: column; gap: 0.6rem;
}
.project-card:hover { border-color: #7c6cfc; background: #1a1a28; }

.project-name { font-size: 1rem; font-weight: 600; color: #e2e2e2; }
.project-meta { display: flex; align-items: center; gap: 0.6rem; }
.deploy-mode { font-size: 0.75rem; color: #555; background: #1f1f1f; border: 1px solid #333; padding: 0.15rem 0.4rem; border-radius: 4px; }
.project-routes { display: flex; flex-wrap: wrap; gap: 0.35rem; }
.route-tag { font-size: 0.75rem; color: #7c6cfc; background: #1e1b3a; border: 1px solid #3a3060; padding: 0.15rem 0.45rem; border-radius: 4px; }
.no-routes { font-size: 0.75rem; color: #444; }
.project-repo { font-size: 0.78rem; color: #555; margin-top: 0.15rem; }

.status { font-size: 0.75rem; padding: 0.2rem 0.5rem; border-radius: 4px; font-weight: 500; }
.status-idle     { background: #1f1f1f; color: #666; }
.status-building { background: #1a1a2a; color: #7c6cfc; }
.status-running  { background: #0e2a14; color: #40c060; }
.status-failed   { background: #2d1414; color: #ff6060; }
.status-stopped  { background: #2a1a00; color: #d4a800; }

.state-msg { color: #666; }
.alert.error { background: #2d1414; border: 1px solid #5a1a1a; color: #ff7070; border-radius: 6px; padding: 0.6rem 0.75rem; font-size: 0.85rem; margin-bottom: 1rem; }

/* ── Modal ── */
.modal-backdrop {
  position: fixed; inset: 0; background: rgba(0,0,0,0.7);
  display: flex; align-items: center; justify-content: center; z-index: 100;
}
.modal {
  background: #161616; border: 1px solid #2a2a2a; border-radius: 12px;
  padding: 2rem; width: 440px; display: flex; flex-direction: column; gap: 1.25rem;
  max-height: 90vh; overflow-y: auto;
}
.modal h2 { font-size: 1.1rem; font-weight: 600; }
label { display: flex; flex-direction: column; gap: 0.4rem; font-size: 0.85rem; color: #9a9a9a; }
.hint { color: #555; font-size: 0.78rem; }
input, select {
  background: #1f1f1f; border: 1px solid #333; border-radius: 6px;
  padding: 0.6rem 0.75rem; color: #e2e2e2; font-size: 0.95rem; outline: none;
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
