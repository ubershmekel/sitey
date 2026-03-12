<template>
  <Layout>
    <div class="page-header">
      <h1>Projects</h1>
      <button class="btn-primary" @click="showAdd = true">+ New project</button>
    </div>

    <div v-if="loading" class="state-msg">Loading...</div>
    <div v-else-if="error" class="alert error">{{ error }}</div>

    <template v-else>
      <div v-if="userProjects.length > 0" class="project-grid">
        <RouterLink v-for="p in userProjects" :key="p.id" :to="`/projects/${p.id}`" class="project-card">
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
      <div v-else class="empty-state">
        <p>No projects yet. Create one to deploy your first app.</p>
        <button class="btn-primary mt-1" @click="showAdd = true">Add project</button>
      </div>
    </template>

    <AddProjectModal
      v-model="showAdd"
      title="New project"
      :domains="domains"
      @created="handleProjectCreated"
    />
  </Layout>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import AddProjectModal from '../components/AddProjectModal.vue'
import Layout from '../components/Layout.vue'
import { trpc } from '../trpc'

type Project = Awaited<ReturnType<typeof trpc.projects.list.query>>[number]
type Route = Project['routes'][number]
type Domain = Awaited<ReturnType<typeof trpc.domains.list.query>>[number]

const projects = ref<Project[]>([])
const loading = ref(true)
const error = ref('')
const showAdd = ref(false)
const domains = ref<Pick<Domain, 'id' | 'hostname'>[]>([])

const userProjects = computed(() => projects.value.filter((p) => !p.protected))

function routeLabel(r: Route): string {
  const host = (() => {
    if (!r.domain?.hostname) return '<server>'
    if (!r.domain.hostname.startsWith('*.')) return r.domain.hostname
    return r.subdomain ? `${r.subdomain}.${r.domain.hostname.slice(2)}` : r.domain.hostname
  })()
  return r.pathPrefix ? `${host}${r.pathPrefix}` : host
}

async function fetchAll() {
  loading.value = true
  error.value = ''
  try {
    const [projectList, domainList] = await Promise.all([
      trpc.projects.list.query(),
      trpc.domains.list.query(),
    ])
    projects.value = projectList
    domains.value = domainList.map((d) => ({ id: d.id, hostname: d.hostname }))
  } catch (e: unknown) {
    error.value = (e as { message?: string })?.message ?? 'Failed to load'
  } finally {
    loading.value = false
  }
}

async function handleProjectCreated() {
  await fetchAll()
}

onMounted(fetchAll)
</script>

<style scoped>
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 2rem;
}

h1 {
  font-size: var(--font-huge);
  font-weight: 600;
}

.project-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1rem;
}

.project-card {
  background: var(--bg-card);
  border: 1px solid var(--border-default);
  border-radius: 10px;
  padding: 1.25rem 1.5rem;
  text-decoration: none;
  color: inherit;
  transition: border-color 0.15s, background 0.15s;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.project-card:hover {
  border-color: var(--brand);
  background: var(--bg-hover);
}

.project-name {
  font-size: var(--font-medium);
  font-weight: 600;
  color: var(--text-primary);
}

.project-meta {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.deploy-mode {
  font-size: var(--font-tiny);
  color: var(--text-muted);
  background: var(--bg-input);
  border: 1px solid var(--border-strong);
  padding: 0.15rem 0.4rem;
  border-radius: 4px;
}

.project-routes {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.route-tag {
  font-size: var(--font-tiny);
  color: var(--brand);
  background: var(--brand-active-bg);
  border: 1px solid #3a3060;
  padding: 0.15rem 0.45rem;
  border-radius: 4px;
}

.no-routes {
  font-size: var(--font-tiny);
  color: var(--text-dim);
}

.project-repo {
  font-size: var(--font-tiny);
  color: var(--text-muted);
  margin-top: 0.15rem;
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

.status-building {
  background: var(--status-queued-bg);
  color: var(--brand);
}

.status-running {
  background: var(--status-ok-bg);
  color: var(--status-ok-text);
}

.status-failed {
  background: var(--status-err-bg);
  color: var(--status-err-text);
}

.status-stopped {
  background: var(--status-warn-bg);
  color: var(--status-warn-text);
}

.state-msg {
  color: var(--text-muted);
}

.empty-state {
  color: var(--text-muted);
  padding: 2rem 0;
}

.mt-1 {
  margin-top: 1rem;
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
</style>
