<template>
  <Layout>
    <div class="page-header">
      <h1>Docker Logs</h1>
    </div>

    <div v-if="containersLoading" class="state-msg">Loading containers...</div>
    <div v-else-if="containersError" class="alert error">
      {{ containersError }}
    </div>

    <div v-else class="logs-layout">
      <!-- Container list -->
      <div class="container-list">
        <div v-if="containers.length === 0" class="empty-msg">
          No containers found.
        </div>
        <button
          v-for="c in containers"
          :key="c.fullId"
          class="container-item"
          :class="{ active: selectedId === c.fullId }"
          @click="selectContainer(c)"
        >
          <div class="container-name">{{ c.serviceName ?? c.name }}</div>
          <div v-if="c.serviceName" class="container-image">{{ c.name }}</div>
          <div class="container-meta">
            <span :class="`state-dot state-${c.state}`"></span>
            <span class="container-status">{{ c.status }}</span>
          </div>
        </button>
        <button
          class="btn-ghost btn-sm refresh-list-btn"
          @click="fetchContainers"
        >
          Refresh list
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
              <label class="parse-label">
                <input type="checkbox" v-model="parseJson" />
                Parse JSON
              </label>
              <label class="tail-label">
                Lines
                <select
                  v-model.number="tailLines"
                  class="tail-select"
                  @change="fetchLogs"
                >
                  <option :value="100">100</option>
                  <option :value="300">300</option>
                  <option :value="500">500</option>
                  <option :value="1000">1000</option>
                  <option :value="2000">2000</option>
                </select>
              </label>
              <button
                class="btn-ghost btn-sm"
                :disabled="logsLoading"
                @click="fetchLogs"
              >
                {{ logsLoading ? "Loading..." : "Refresh" }}
              </button>
            </div>
          </div>
          <div class="log-box" ref="logBox">
            <div v-if="logsLoading && logLines.length === 0" class="log-empty">
              Loading...
            </div>
            <div v-else-if="logLines.length === 0" class="log-empty">
              No log output.
            </div>
            <pre v-else class="log-content">{{ displayLines.join("\n") }}</pre>
          </div>
        </template>
      </div>
    </div>
  </Layout>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from "vue";
import { useRoute, useRouter } from "vue-router";
import Layout from "../components/Layout.vue";
import { trpc } from "../trpc";

type Container = Awaited<
  ReturnType<typeof trpc.system.listContainers.query>
>[number];

function timeAgo(date: Date): string {
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

function normLevel(level: unknown): string {
  if (typeof level === "string") return level.toUpperCase();
  if (typeof level === "number") {
    if (level < 20) return "TRACE";
    if (level < 30) return "DEBUG";
    if (level < 40) return "INFO";
    if (level < 50) return "WARN";
    if (level < 60) return "ERROR";
    return "FATAL";
  }
  return String(level);
}

function formatJsonLine(line: string): string {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line);
  } catch {
    return line;
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj))
    return line;

  const skip = new Set(["ts", "time", "level", "msg"]);

  // Convert timestamp: ts = unix seconds float, time = unix ms
  let timeStr = "";
  const tsRaw = obj.ts ?? obj.time;
  if (typeof tsRaw === "number") {
    const ms = obj.time !== undefined ? tsRaw : tsRaw * 1000;
    const date = new Date(ms);
    timeStr = `[${date.toISOString()} ${timeAgo(date)}] `;
  }

  const level = obj.level !== undefined ? `${normLevel(obj.level)} ` : "";
  const msg = obj.msg ? `${String(obj.msg)}  ` : "";

  const rest = Object.entries(obj)
    .filter(([k]) => !skip.has(k))
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join("  ");

  return `${timeStr}${level}${msg}${rest}`.trimEnd();
}

const route = useRoute();
const router = useRouter();

const rawContainers = ref<Container[]>([]);
const containers = computed(() =>
  [...rawContainers.value].sort((a, b) => {
    const aRunning = a.state === "running" ? 0 : 1;
    const bRunning = b.state === "running" ? 0 : 1;
    if (aRunning !== bRunning) return aRunning - bRunning;
    return a.name.localeCompare(b.name);
  }),
);
const containersLoading = ref(true);
const containersError = ref("");

const selectedId = ref("");
const selectedName = ref("");
const logLines = ref<string[]>([]);
const logsLoading = ref(false);
const tailLines = ref(100);
const parseJson = ref(false);
const logBox = ref<HTMLElement | null>(null);

const displayLines = computed(() =>
  parseJson.value ? logLines.value.map(formatJsonLine) : logLines.value,
);

async function fetchContainers() {
  containersLoading.value = true;
  containersError.value = "";
  try {
    rawContainers.value = await trpc.system.listContainers.query();

    // Auto-select from route param /logs/:container
    const paramName = route.params.container as string | undefined;
    if (paramName && !selectedId.value) {
      const match = containers.value.find((c) => c.name === paramName);
      if (match) selectContainer(match);
    }
  } catch (e: unknown) {
    containersError.value =
      (e as { message?: string })?.message ?? "Failed to load containers";
  } finally {
    containersLoading.value = false;
  }
}

async function selectContainer(c: Container) {
  selectedId.value = c.fullId;
  selectedName.value = c.name;
  logLines.value = [];
  router.replace({ params: { container: c.name } });
  await fetchLogs();
}

async function fetchLogs() {
  if (!selectedId.value) return;
  logsLoading.value = true;
  try {
    const res = await trpc.system.getContainerLogs.query({
      containerId: selectedId.value,
      tail: tailLines.value,
    });
    logLines.value = res.lines;
    await nextTick();
    if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight;
  } catch (e: unknown) {
    logLines.value = [
      (e as { message?: string })?.message ?? "Failed to load logs",
    ];
  } finally {
    logsLoading.value = false;
  }
}

onMounted(fetchContainers);
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

@media (max-width: 640px) {
  .logs-layout {
    grid-template-columns: 1fr;
    height: auto;
  }

  .container-list {
    overflow-y: visible;
    flex-wrap: wrap;
    flex-direction: row;
    gap: 0.4rem;
  }

  .log-box {
    min-height: 300px;
    max-height: calc(100vh - 20rem);
  }
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
  transition:
    border-color 0.15s,
    background 0.15s;
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

.state-running {
  background: var(--status-ok-text);
}
.state-exited {
  background: var(--text-dim);
}
.state-paused {
  background: var(--status-warn-text);
}
.state-restarting {
  background: var(--status-info-text);
}

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

.parse-label {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: var(--font-tiny);
  cursor: pointer;
  user-select: none;
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

.refresh-list-btn {
  margin-top: auto;
  width: 100%;
  justify-content: center;
}

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

.btn-sm {
  padding: 0.35rem 0.75rem;
  font-size: var(--font-tiny);
}
</style>
