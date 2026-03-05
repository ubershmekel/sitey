<template>
  <Layout>
    <div class="page-header">
      <h1>Domains</h1>
      <button class="btn-primary" @click="showAdd = true">+ Add domain</button>
    </div>

    <div v-if="loading" class="state-msg">Loading…</div>
    <div v-else-if="error" class="alert error">{{ error }}</div>

    <div v-else-if="domains.length === 0" class="empty-state">
      <div class="empty-icon">◈</div>
      <p>No domains yet.</p>
      <p class="hint">Add your first domain to get started.</p>
      <button class="btn-primary" @click="showAdd = true">Add domain</button>
    </div>

    <div v-else class="domain-grid">
      <RouterLink
        v-for="d in domains"
        :key="d.id"
        :to="`/domains/${d.id}`"
        class="domain-card"
      >
        <div class="domain-name">{{ d.hostname }}</div>
        <div class="domain-meta">
          <span :class="`status status-${d.status}`">{{ d.status }}</span>
          <span class="projects-count">{{ d._count.projects }} project{{ d._count.projects !== 1 ? 's' : '' }}</span>
        </div>
      </RouterLink>
    </div>

    <!-- Add domain modal -->
    <div v-if="showAdd" class="modal-backdrop" @click.self="showAdd = false">
      <form class="modal" @submit.prevent="addDomain">
        <h2>Add domain</h2>

        <div v-if="addError" class="alert error">{{ addError }}</div>

        <label>
          Hostname <span class="hint">(e.g. myapp.com)</span>
          <input v-model="newHostname" type="text" required placeholder="myapp.com" />
        </label>
        <label>
          Let's Encrypt email
          <input v-model="newEmail" type="email" required placeholder="you@example.com" />
        </label>

        <div class="modal-actions">
          <button type="button" class="btn-ghost" @click="showAdd = false">Cancel</button>
          <button type="submit" class="btn-primary" :disabled="adding">
            {{ adding ? 'Adding…' : 'Add domain' }}
          </button>
        </div>
      </form>
    </div>
  </Layout>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import Layout from '../components/Layout.vue'
import { trpc } from '../trpc'

type Domain = Awaited<ReturnType<typeof trpc.domains.list.query>>[number]

const domains = ref<Domain[]>([])
const loading = ref(true)
const error = ref('')
const showAdd = ref(false)
const newHostname = ref('')
const newEmail = ref('')
const adding = ref(false)
const addError = ref('')

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

async function addDomain() {
  addError.value = ''
  adding.value = true
  try {
    await trpc.domains.create.mutate({
      hostname: newHostname.value.trim().toLowerCase(),
      letsEncryptEmail: newEmail.value.trim(),
    })
    showAdd.value = false
    newHostname.value = ''
    newEmail.value = ''
    await fetchDomains()
  } catch (e: unknown) {
    addError.value = (e as { message?: string })?.message ?? 'Failed to add domain'
  } finally {
    adding.value = false
  }
}

onMounted(fetchDomains)
</script>

<style scoped>
.page-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 2rem;
}
h1 { font-size: 1.4rem; font-weight: 600; }

.domain-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 1rem;
}

.domain-card {
  background: #161616;
  border: 1px solid #2a2a2a;
  border-radius: 10px;
  padding: 1.25rem 1.5rem;
  text-decoration: none;
  color: inherit;
  transition: border-color 0.15s, background 0.15s;
  display: block;
}
.domain-card:hover { border-color: #7c6cfc; background: #1a1a28; }

.domain-name { font-size: 1rem; font-weight: 600; margin-bottom: 0.75rem; color: #e2e2e2; }
.domain-meta { display: flex; align-items: center; gap: 0.75rem; }
.projects-count { font-size: 0.8rem; color: #666; }

.status { font-size: 0.75rem; padding: 0.2rem 0.5rem; border-radius: 4px; font-weight: 500; }
.status-pending  { background: #2a2206; color: #d4a800; }
.status-active   { background: #0e2a14; color: #40c060; }
.status-error    { background: #2d1414; color: #ff6060; }

.empty-state {
  text-align: center; padding: 4rem 2rem; color: #555;
}
.empty-icon { font-size: 2.5rem; margin-bottom: 1rem; }
.hint { font-size: 0.85rem; margin: 0.25rem 0 1.5rem; }

.state-msg { color: #666; }
.alert.error { background: #2d1414; border: 1px solid #5a1a1a; color: #ff7070; border-radius: 6px; padding: 0.6rem 0.75rem; font-size: 0.85rem; margin-bottom: 1rem; }

/* Modal */
.modal-backdrop {
  position: fixed; inset: 0; background: rgba(0,0,0,0.7);
  display: flex; align-items: center; justify-content: center; z-index: 100;
}
.modal {
  background: #161616; border: 1px solid #2a2a2a; border-radius: 12px;
  padding: 2rem; width: 420px; display: flex; flex-direction: column; gap: 1.25rem;
}
.modal h2 { font-size: 1.1rem; font-weight: 600; }
label { display: flex; flex-direction: column; gap: 0.4rem; font-size: 0.85rem; color: #9a9a9a; }
.hint { color: #555; font-size: 0.78rem; }
input {
  background: #1f1f1f; border: 1px solid #333; border-radius: 6px;
  padding: 0.6rem 0.75rem; color: #e2e2e2; font-size: 0.95rem; outline: none;
  transition: border-color 0.15s;
}
input:focus { border-color: #7c6cfc; }
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
