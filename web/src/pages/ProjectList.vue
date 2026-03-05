<template>
  <Layout>
    <div class="page-header">
      <h1>Projects</h1>
      <button class="btn-primary" @click="showAdd = true">+ New project</button>
    </div>

    <div v-if="loading" class="state-msg">Loading…</div>
    <div v-else-if="error" class="alert error">{{ error }}</div>

    <div v-else-if="userProjects.length === 0" class="empty-state">
      <div class="empty-icon">▦</div>
      <p>No projects yet.</p>
      <p class="hint">Create a project to deploy your first app.</p>
      <button class="btn-primary" @click="showAdd = true">New project</button>
    </div>

    <div v-else class="project-grid">
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
          GitHub repo
          <div class="repo-row">
            <input v-model="form.repoOwner" type="text" required placeholder="owner" style="flex:1" />
            <span style="color:#555;align-self:center">/</span>
            <input v-model="form.repoName" type="text" required placeholder="repo" style="flex:2" />
          </div>
        </label>
        <label>
          Branch
          <input v-model="form.branch" type="text" placeholder="main" />
        </label>
        <label>
          Deploy mode
          <select v-model="form.deployMode">
            <option value="server">Server (process / API)</option>
            <option value="static">Static (build + serve files)</option>
          </select>
        </label>
        <template v-if="form.deployMode === 'static'">
          <label>
            Build command
            <input v-model="form.buildCommand" type="text" placeholder="npm run build" />
          </label>
          <label>
            Output directory
            <input v-model="form.outputDir" type="text" placeholder="dist" />
          </label>
        </template>

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
import { ref, computed, onMounted } from 'vue'
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

const form = ref({
  name: '',
  repoOwner: '',
  repoName: '',
  branch: 'main',
  deployMode: 'server' as 'server' | 'static',
  buildCommand: '',
  outputDir: 'dist',
})

// Exclude the built-in protected sitey project from the list
const userProjects = computed(() => projects.value.filter(p => !p.protected))

function routeLabel(r: Route): string {
  const host = r.domain?.hostname ?? '<server>'
  return r.pathPrefix ? `${host}${r.pathPrefix}` : host
}

async function fetchProjects() {
  loading.value = true
  error.value = ''
  try {
    projects.value = await trpc.projects.list.query()
  } catch (e: unknown) {
    error.value = (e as { message?: string })?.message ?? 'Failed to load projects'
  } finally {
    loading.value = false
  }
}

async function addProject() {
  addError.value = ''
  adding.value = true
  try {
    await trpc.projects.create.mutate({
      name: form.value.name.trim(),
      repoOwner: form.value.repoOwner.trim(),
      repoName: form.value.repoName.trim(),
      branch: form.value.branch.trim() || 'main',
      deployMode: form.value.deployMode,
      buildCommand: form.value.buildCommand.trim(),
      outputDir: form.value.outputDir.trim() || 'dist',
    })
    showAdd.value = false
    form.value = { name: '', repoOwner: '', repoName: '', branch: 'main', deployMode: 'server', buildCommand: '', outputDir: 'dist' }
    await fetchProjects()
  } catch (e: unknown) {
    addError.value = (e as { message?: string })?.message ?? 'Failed to create project'
  } finally {
    adding.value = false
  }
}

onMounted(fetchProjects)
</script>

<style scoped>
.page-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 2rem;
}
h1 { font-size: 1.4rem; font-weight: 600; }

.project-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1rem;
}

.project-card {
  background: #161616;
  border: 1px solid #2a2a2a;
  border-radius: 10px;
  padding: 1.25rem 1.5rem;
  text-decoration: none;
  color: inherit;
  transition: border-color 0.15s, background 0.15s;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
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

.empty-state { text-align: center; padding: 4rem 2rem; color: #555; }
.empty-icon { font-size: 2.5rem; margin-bottom: 1rem; }
.hint { font-size: 0.85rem; margin: 0.25rem 0 1.5rem; }
.state-msg { color: #666; }
.alert.error { background: #2d1414; border: 1px solid #5a1a1a; color: #ff7070; border-radius: 6px; padding: 0.6rem 0.75rem; font-size: 0.85rem; margin-bottom: 1rem; }

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
.repo-row { display: flex; align-items: center; gap: 0.4rem; }
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
