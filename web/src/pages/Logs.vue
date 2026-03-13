<template>
  <Layout>
    <div class="page-header">
      <h1>Docker Logs</h1>
      <button class="btn-ghost btn-sm" @click="fetchContainers">Refresh</button>
    </div>

    <div v-if="containersLoading" class="state-msg">Loading containers...</div>
    <div v-else-if="containersError" class="alert error">{{ containersError }}</div>

    <div v-else class="logs-layout">
      <!-- Container list -->
      <div class="container-list">
        <div v-if="containers.length === 0" class="empty-msg">No containers found.</div>
        <button
          v-for="c in containers"
          :key="c.fullId"
          class="container-item"
          :class="{ active: selectedId === c.fullId }"
          @click="selectContainer(c)"
        >
          <div class="container-name">{{ c.name }}</div>
          <div class="container-meta">
            <span :class="`state-dot state-${c.state}`"></span>
            <span class="container-status">{{ c.status }}</span>
          </div>
          <div class="container-image">{{ c.image }}</div>
        </button>
      </div>

      <!-- Log viewer -->
      <div class="log-pane">
        <div v-if="!selectedId" class="log-placeholder">
          Select a container to view its logs.
        </div>
        <template v-else>
          <div class="log-pane-header">
            <span class="log-pane-title">{{ selectedName }}</span>
            <div class="log-pane-actions">
              <label class="tail-label">
                Lines
                <select v-model.number="tailLines" class="tail-select" @change="fetchLogs">
                  <option :value="100">100</option>
                  <option :value="300">300</option>
                  <option :value="500">500</option>
                  <option :value="1000">1000</option>
                  <option :value="2000">2000</option>
                </select>
              </label>
              <button class="btn-ghost btn-sm" :disabled="logsLoading" @click="fetchLogs">
                {{ logsLoading ? 'Loading...' : 'Refresh' }}
              </button>
            </div>
          </div>
          <div class="log-box" ref="logBox">
            <div v-if="logsLoading && logLines.length === 0" class="log-empty">Loading...</div>
            <div v-else-if="logLines.length === 0" class="log-empty">No log output.</div>
            <pre v-else class="log-content">{{ logLines.join('\n') }}</pre>
          </div>
        </template>
      </div>
    </div>
  </Layout>
</template>

<script setup lang="ts">
import { ref, onMounted, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import Layout from '../components/Layout.vue'
import { trpc } from '../trpc'

type Container = Awaited<ReturnType<typeof trpc.system.listContainers.query>>[number]

const route = useRoute()

const containers = ref<Container[]>([])
const containersLoading = ref(true)
const containersError = ref('')

const selectedId = ref('')
const selectedName = ref('')
const logLines = ref<string[]>([])
const logsLoading = ref(false)
const tailLines = ref(300)
const logBox = ref<HTMLElement | null>(null)

async function fetchContainers() {
  containersLoading.value = true
  containersError.value = ''
  try {
    containers.value = await trpc.system.listContainers.query()

    // Auto-select from query param ?container=<name>
    const paramName = route.query.container as string | undefined
    if (paramName && !selectedId.value) {
      const match = containers.value.find(c => c.name === paramName)
      if (match) selectContainer(match)
    }
  } catch (e: unknown) {
    containersError.value = (e as { message?: string })?.message ?? 'Failed to load containers'
  } finally {
    containersLoading.value = false
  }
}

async function selectContainer(c: Container) {
  selectedId.value = c.fullId
  selectedName.value = c.name
  logLines.value = []
  await fetchLogs()
}

async function fetchLogs() {
  if (!selectedId.value) return
  logsLoading.value = true
  try {
    const res = await trpc.system.getContainerLogs.query({
      containerId: selectedId.value,
      tail: tailLines.value,
    })
    logLines.value = res.lines
    await nextTick()
    if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight
  } catch (e: unknown) {
    logLines.value = [(e as { message?: string })?.message ?? 'Failed to load logs']
  } finally {
    logsLoading.value = false
  }
}

onMounted(fetchContainers)
</script>

<style scoped>
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1.5rem;
}

h1 {
  font-weight: 600;
}

.logs-layout {
  display: grid;
  grid-template-columns: 240px 1fr;
  gap: 1rem;
  height: calc(100vh - 8rem);
  min-height: 400px;
}

/* Container list */
.container-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
}

.container-item {
  text-align: left;
  background: var(--bg-card);
  border: 1px solid var(--border-default);
  border-radius: 7px;
  padding: 0.65rem 0.75rem;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.container-item:hover {
  border-color: var(--border-strong);
  background: var(--bg-hover);
}

.container-item.active {
  border-color: var(--brand);
  background: var(--brand-active-bg);
}

.container-name {
  font-size: var(--font-tiny);
  font-weight: 600;
  word-break: break-all;
}

.container-item.active .container-name {
  color: var(--brand-active-text);
}

.container-meta {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.state-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.state-running { background: var(--status-ok-text); }
.state-exited { background: var(--text-dim); }
.state-paused { background: var(--status-warn-text); }
.state-restarting { background: var(--status-info-text); }

.container-status {
  font-size: var(--font-tiny);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.container-image {
  font-size: var(--font-tiny);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: monospace;
}

/* Log pane */
.log-pane {
  display: flex;
  flex-direction: column;
  gap: 0;
  min-height: 0;
}

.log-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  background: var(--bg-card);
  border: 1px solid var(--border-default);
  border-radius: 8px;
}

.log-pane-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.6rem 0.75rem;
  background: var(--bg-card);
  border: 1px solid var(--border-default);
  border-bottom: none;
  border-radius: 8px 8px 0 0;
  gap: 1rem;
}

.log-pane-title {
  font-size: var(--font-tiny);
  font-weight: 600;
  font-family: monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.log-pane-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-shrink: 0;
}

.tail-label {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  }

.tail-select {
  background: var(--bg-input);
  border: 1px solid var(--border-strong);
  border-radius: 5px;
  padding: 0.2rem 0.4rem;
  font-size: var(--font-tiny);
  outline: none;
}

.log-box {
  flex: 1;
  background: var(--bg-code);
  border: 1px solid var(--border-default);
  border-radius: 0 0 8px 8px;
  padding: 0.85rem 1rem;
  overflow-y: auto;
  font-family: monospace;
  font-size: var(--font-tiny);
  line-height: 1.5;
  min-height: 0;
}

.log-content {
  color: var(--status-ok-text);
  white-space: pre-wrap;
  word-break: break-all;
}


/* Misc */

.empty-msg {
  font-size: var(--font-tiny);
}

.alert.error {
  background: var(--status-err-bg);
  border: 1px solid var(--status-err-border);
  color: var(--status-err-text);
  border-radius: 6px;
  padding: 0.6rem 0.75rem;
}

.btn-ghost {
  background: none;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  padding: 0.5rem 1rem;
  font-size: var(--font-tiny);
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}

.btn-ghost:hover {
  border-color: var(--text-muted);
}

.btn-ghost:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-sm {
  padding: 0.35rem 0.75rem;
  font-size: var(--font-tiny);
}
</style>





