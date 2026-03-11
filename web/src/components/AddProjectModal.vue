<template>
  <div v-if="modelValue" class="modal-backdrop" @click.self="close">
    <form class="modal" @submit.prevent="addProject">
      <h2>{{ title }}</h2>

      <div v-if="addError" class="alert error">{{ addError }}</div>

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
        Project name <span class="hint">(auto-filled from repository, lowercase and hyphens only)</span>
        <input v-model="form.name" type="text" required placeholder="my-app" pattern="[a-z0-9-]+" />
      </label>

      <label>
        Branch
        <input v-model="form.branch" type="text" placeholder="main" list="branch-list" />
        <datalist id="branch-list">
          <option v-for="b in branches" :key="b" :value="b" />
        </datalist>
      </label>

      <label v-if="allowDomainSelection">
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
        <button type="button" class="btn-ghost" @click="close">Cancel</button>
        <button type="submit" class="btn-primary" :disabled="adding">
          {{ adding ? 'Creating...' : 'Create project' }}
        </button>
      </div>
    </form>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { trpc } from '../trpc'

type AppRepo = Awaited<ReturnType<typeof trpc.github.listAppRepos.query>>['repos'][number]
type DomainOption = { id: number; hostname: string }

const props = withDefaults(defineProps<{
  modelValue: boolean
  title?: string
  domains?: DomainOption[]
  fixedDomainId?: number | null
}>(), {
  title: 'New project',
  domains: () => [],
  fixedDomainId: null,
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'created', projectId: number): void
}>()

const adding = ref(false)
const addError = ref('')
const branches = ref<string[]>([])
const appRepos = ref<AppRepo[]>([])
const reposLoading = ref(false)
const repoLoadError = ref('')
const reposConfigured = ref(false)
const repoInstallations = ref<number>(0)
const repoInstallUrl = ref('')
const inferredProjectName = ref('')

const form = ref(emptyForm())

const repoByFullName = computed(() => {
  return new Map(appRepos.value.map(repo => [repo.fullName.toLowerCase(), repo]))
})

const allowDomainSelection = computed(() => props.fixedDomainId == null && props.domains.length > 0)

function emptyForm() {
  return {
    name: '',
    githubUrl: '',
    repoOwner: '',
    repoName: '',
    domainId: null as number | null,
    branch: 'main',
    buildCommand: '',
    outputDir: '',
    serverRunCommand: '',
    containerPort: 3000,
  }
}

function close() {
  emit('update:modelValue', false)
}

function parseGithubUrl() {
  const val = form.value.githubUrl.trim()
  const match = val.match(/(?:github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?$/) ?? val.match(/^([^/]+)\/([^/]+)$/)
  if (!match) return

  form.value.repoOwner = match[1]
  form.value.repoName = match[2]
  inferProjectName(match[2])

  const selected = repoByFullName.value.get(`${match[1]}/${match[2]}`.toLowerCase())
  if (selected?.defaultBranch && (!form.value.branch.trim() || form.value.branch === 'main')) {
    form.value.branch = selected.defaultBranch
  }
  fetchBranches()
}

function inferProjectName(repoName: string) {
  const inferred = repoName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')

  if (!inferred) return
  if (!form.value.name.trim() || form.value.name === inferredProjectName.value) {
    form.value.name = inferred
  }
  inferredProjectName.value = inferred
}

async function fetchBranches() {
  const { repoOwner, repoName } = form.value
  if (!repoOwner || !repoName) return
  try {
    const res = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/branches?per_page=50`)
    if (!res.ok) return
    const data = await res.json() as { name: string }[]
    branches.value = data.map(b => b.name)
  } catch {
    // ignore: branch autocomplete is optional
  }
}

async function loadRepoSuggestions() {
  reposLoading.value = true
  repoLoadError.value = ''
  try {
    const res = await trpc.github.listAppRepos.query()
    appRepos.value = res.repos
    reposConfigured.value = res.configured
    repoInstallations.value = Array.isArray(res.installations) ? res.installations.length : 0
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
    const isStatic = !form.value.serverRunCommand.trim()
    const created = await trpc.projects.create.mutate({
      name: form.value.name.trim(),
      repoOwner: form.value.repoOwner.trim(),
      repoName: form.value.repoName.trim(),
      branch: form.value.branch.trim() || 'main',
      githubMode: reposConfigured.value ? 'app' : 'webhook',
      deployMode: isStatic ? 'static' : 'server',
      buildCommand: form.value.buildCommand.trim(),
      outputDir: form.value.outputDir.trim(),
      serverRunCommand: form.value.serverRunCommand.trim(),
      buildMode: 'auto',
      containerPort: form.value.containerPort,
    })

    const routeDomainId = props.fixedDomainId ?? form.value.domainId
    if (routeDomainId) {
      await trpc.projects.addRoute.mutate({
        projectId: created.id,
        domainId: routeDomainId,
      })
    }

    emit('created', created.id)
    emit('update:modelValue', false)
  } catch (e: unknown) {
    addError.value = (e as { message?: string })?.message ?? 'Failed to create project'
  } finally {
    adding.value = false
  }
}

watch(() => props.modelValue, async (visible) => {
  if (!visible) {
    form.value = emptyForm()
    branches.value = []
    inferredProjectName.value = ''
    addError.value = ''
    return
  }

  if (allowDomainSelection.value && props.domains.length === 1) {
    form.value.domainId = props.domains[0].id
  }
  await loadRepoSuggestions()
})
</script>

<style scoped>
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
  font-size: 0.95rem;
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

.alert.error {
  background: var(--status-err-bg);
  border: 1px solid var(--status-err-border);
  color: var(--status-err-text);
  border-radius: 6px;
  padding: 0.6rem 0.75rem;
  font-size: 0.85rem;
}
</style>
