<template>
  <Layout>
    <div class="page-header">
      <h1>Domains</h1>
      <button class="btn-primary" @click="openAddModal">+ Add domain</button>
    </div>

    <div v-if="loading" class="state-msg">Loading…</div>
    <div v-else-if="error" class="alert error">{{ error }}</div>

    <div v-else-if="domains.length === 0" class="empty-state">
      <div class="empty-icon"><NavIcon name="domains" /></div>
      <p>No domains yet.</p>
      <p class="hint">Add your first domain to get started.</p>
      <button class="btn-primary" @click="openAddModal">Add domain</button>
    </div>

    <div v-else class="domain-grid">
      <RouterLink v-for="d in domains" :key="d.id" :to="`/domains/${d.id}`" class="domain-card">
        <div class="domain-name">{{ d.hostname }}</div>
        <div class="domain-meta">
          <div class="status-row">
            <span class="meta-label">Let's Encrypt</span>
            <span :class="`status status-${d.letsEncryptStatus ?? d.status}`">
              {{ d.letsEncryptStatus ?? d.status }}
            </span>
          </div>
          <span class="projects-count">{{ d._count.routes }} project{{ d._count.routes !== 1 ? 's' : '' }}</span>
        </div>
      </RouterLink>
    </div>

    <AddDomainModal v-model="showAdd" @created="fetchDomains" />
  </Layout>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import Layout from '../components/Layout.vue'
import NavIcon from '../components/NavIcon.vue'
import AddDomainModal from '../components/AddDomainModal.vue'
import { trpc } from '../trpc'

type Domain = Awaited<ReturnType<typeof trpc.domains.list.query>>[number]

const domains = ref<Domain[]>([])
const loading = ref(true)
const error = ref('')
const showAdd = ref(false)

function openAddModal() { showAdd.value = true }

async function fetchDomains() {
  loading.value = true
  error.value = ''
  try {
    domains.value = await trpc.domains.list.query()
  } catch (e: unknown) {
    error.value = (e as { message?: string })?.message ?? 'Failed to load domains'
  } finally {
    loading.value = false
  }
}

onMounted(fetchDomains)
</script>

<style scoped>
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 2rem;
}

h1 {
  font-weight: 600;
}

.domain-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 1rem;
}

.domain-card {
  background: var(--bg-card);
  border: 1px solid var(--border-default);
  border-radius: 10px;
  padding: 1.25rem 1.5rem;
  text-decoration: none;
  color: inherit;
  transition: border-color 0.15s, background 0.15s;
  display: block;
}

.domain-card:hover {
  border-color: var(--brand);
  background: var(--bg-hover);
}

.domain-name {
  font-weight: 600;
  margin-bottom: 0.75rem;
  }

.domain-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.status-row {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}

.meta-label {
  font-size: var(--font-tiny);
  }

.projects-count {
  font-size: var(--font-tiny);
  }

.status {
  font-size: var(--font-tiny);
  padding: 0.2rem 0.5rem;
  border-radius: 4px;
  font-weight: 500;
}

.status-pending {
  background: var(--status-warn-bg);
  color: var(--status-warn-text);
}

.status-active {
  background: var(--status-ok-bg);
  color: var(--status-ok-text);
}

.status-error {
  background: var(--status-err-bg);
  color: var(--status-err-text);
}

.empty-state {
  text-align: center;
  padding: 4rem 2rem;
  }

.empty-icon {
  font-size: 2.5rem;
  margin-bottom: 1rem;
}


.hint {
  margin: 0.25rem 0 1.5rem;
}


.alert.error {
  background: var(--status-err-bg);
  border: 1px solid var(--status-err-border);
  color: var(--status-err-text);
  border-radius: 6px;
  padding: 0.6rem 0.75rem;
  margin-bottom: 1rem;
}


</style>


