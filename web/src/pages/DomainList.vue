<template>
  <Layout>
    <div class="page-header">
      <h1>Domains</h1>
      <button class="btn-primary" @click="openAddModal">+ Add domain</button>
    </div>

    <div v-if="loading" class="state-msg">Loading…</div>
    <div v-else-if="error" class="alert error">{{ error }}</div>

    <div v-else-if="domains.length === 0" class="empty-state">
      <div class="empty-icon">◈</div>
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

    <!-- Add domain modal -->
    <div v-if="showAdd" class="modal-backdrop" @click.self="showAdd = false">
      <form class="modal" @submit.prevent="addDomain">
        <h2>Add domain</h2>

        <div v-if="addError" class="alert error">{{ addError }}</div>

        <div class="tip">
          <strong>Tip: wildcard subdomain setup</strong><br>
          Point a wildcard DNS A record <code>*.yourdomain.com → your server IP</code> (in addition to
          <code>yourdomain.com → IP</code>). Then every new project automatically gets a
          random subdomain like <code>happy-fox-3k2.yourdomain.com</code> — just like Netlify
          or Vercel — with no extra DNS steps per project.
        </div>

        <label>
          Hostname <span class="hint">(e.g. myapp.com or *.myapp.com)</span>
          <input v-model="newHostname" type="text" required placeholder="myapp.com" @blur="checkDns" />
        </label>
        <div v-if="dnsResult !== null" class="dns-check">
          <span v-if="dnsResult.resolves && !dnsResult.wildcard" class="dns-ok">
            Resolves: {{ dnsResult.addresses.join(', ') }}
          </span>
          <span v-else-if="dnsResult.resolves && dnsResult.wildcard" class="dns-ok">
            Wildcard test resolves ({{ dnsResult.checkedHostname }}): {{ dnsResult.addresses.join(', ') }}
          </span>
          <span v-else-if="!dnsResult.resolves && dnsResult.wildcard" class="dns-fail">
            Wildcard test host {{ dnsResult.checkedHostname }} is not resolving.
          </span>
          <span v-else class="dns-fail">
            DNS not resolving - make sure an A record points to this server
          </span>
        </div>
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
const adding = ref(false)
const addError = ref('')
type DnsResult = {
  resolves: boolean
  addresses: string[]
  checkedHostname: string
  wildcard: boolean
} | null
const dnsResult = ref<DnsResult>(null)

async function checkDns() {
  const h = newHostname.value.trim().toLowerCase()
  if (!h) { dnsResult.value = null; return }
  dnsResult.value = await trpc.domains.checkDns.query({ hostname: h })
}

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
    const hostname = newHostname.value.trim().toLowerCase()
    await trpc.domains.create.mutate({
      hostname,
    })
    showAdd.value = false
    newHostname.value = ''
    dnsResult.value = null
    await fetchDomains()
  } catch (e: unknown) {
    addError.value = (e as { message?: string })?.message ?? 'Failed to add domain'
  } finally {
    adding.value = false
  }
}

function openAddModal() {
  showAdd.value = true
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
  font-size: 1.4rem;
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
  font-size: 1rem;
  font-weight: 600;
  margin-bottom: 0.75rem;
  color: var(--text-primary);
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
  font-size: 0.74rem;
  color: var(--text-muted);
}

.projects-count {
  font-size: 0.8rem;
  color: var(--text-muted);
}

.status {
  font-size: 0.75rem;
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
  color: var(--text-muted);
}

.empty-icon {
  font-size: 2.5rem;
  margin-bottom: 1rem;
}

.hint {
  font-size: 0.85rem;
  margin: 0.25rem 0 1.5rem;
}

.state-msg {
  color: var(--text-muted);
}

.alert.error {
  background: var(--status-err-bg);
  border: 1px solid var(--status-err-border);
  color: var(--status-err-text);
  border-radius: 6px;
  padding: 0.6rem 0.75rem;
  font-size: 0.85rem;
  margin-bottom: 1rem;
}

/* Modal */
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
  width: 420px;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
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

input {
  background: var(--bg-input);
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  padding: 0.6rem 0.75rem;
  color: var(--text-primary);
  font-size: 0.95rem;
  outline: none;
  transition: border-color 0.15s;
}

input:focus {
  border-color: var(--brand);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  margin-top: 0.5rem;
}

.btn-primary {
  background: var(--brand);
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 0.6rem 1.25rem;
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-primary:hover:not(:disabled) {
  opacity: 0.85;
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

.dns-check {
  font-size: 0.82rem;
  padding: 0.1rem 0;
}

.dns-ok {
  color: var(--status-ok-text);
}

.dns-fail {
  color: var(--status-err-text);
}

.tip {
  background: var(--status-info-bg);
  border: 1px solid var(--status-info-border);
  border-radius: 8px;
  padding: 0.75rem 1rem;
  font-size: 0.82rem;
  color: var(--status-info-text);
  line-height: 1.55;
}

.tip strong {
  color: #a8caee;
}

.tip code {
  background: #1a2a40;
  border-radius: 3px;
  padding: 0.1em 0.35em;
  font-size: 0.85em;
  color: #9dcfff;
}
</style>
