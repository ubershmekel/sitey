<template>
  <Layout>
    <div class="page-header">
      <h1>Analytics</h1>
      <div class="header-actions">
        <select v-model="days" class="days-select" @change="fetchStats">
          <option :value="7">Last 7 days</option>
          <option :value="30">Last 30 days</option>
          <option :value="90">Last 90 days</option>
        </select>
        <button class="btn-secondary" :disabled="refreshing" @click="refresh">
          {{ refreshing ? "Refreshing…" : "Refresh" }}
        </button>
      </div>
    </div>

    <div v-if="loading" class="state-msg">Loading…</div>
    <div v-else-if="error" class="alert error">{{ error }}</div>

    <template v-else>
      <div v-if="rows.length === 0" class="empty-state">
        <p>No data yet.</p>
        <p class="hint">
          Analytics are collected from Caddy access logs every 5 minutes.
          Traffic to your deployed services will appear here automatically.
        </p>
      </div>

      <template v-else>
        <!-- Summary cards -->
        <div class="summary-row">
          <div class="summary-card">
            <div class="summary-value">{{ totalRequests.toLocaleString() }}</div>
            <div class="summary-label">Total requests</div>
          </div>
          <div class="summary-card">
            <div class="summary-value">{{ totalErrors.toLocaleString() }}</div>
            <div class="summary-label">Errors (4xx/5xx)</div>
          </div>
          <div class="summary-card">
            <div class="summary-value">{{ hostnames.length }}</div>
            <div class="summary-label">
              {{ hostnames.length === 1 ? "Hostname" : "Hostnames" }}
            </div>
          </div>
        </div>

        <!-- Per-hostname table -->
        <div class="section-title">By hostname</div>
        <div class="table-wrap">
          <table class="stats-table">
            <thead>
              <tr>
                <th>Hostname</th>
                <th class="num">Requests</th>
                <th class="num">Errors</th>
                <th class="num">Error rate</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="h in hostSummary" :key="h.hostname">
                <td class="hostname">{{ h.hostname }}</td>
                <td class="num">{{ h.requests.toLocaleString() }}</td>
                <td class="num">{{ h.errors.toLocaleString() }}</td>
                <td class="num">
                  <span
                    :class="h.errorRate > 5 ? 'rate-high' : h.errorRate > 0 ? 'rate-mid' : 'rate-ok'"
                  >
                    {{ h.errorRate.toFixed(1) }}%
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Daily totals table -->
        <div class="section-title">By day</div>
        <div class="table-wrap">
          <table class="stats-table">
            <thead>
              <tr>
                <th>Date</th>
                <th class="num">Requests</th>
                <th class="num">Errors</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="d in dailySummary" :key="d.date">
                <td>{{ d.date }}</td>
                <td class="num">{{ d.requests.toLocaleString() }}</td>
                <td class="num">{{ d.errors.toLocaleString() }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </template>
  </Layout>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import Layout from "../components/Layout.vue";
import { trpc } from "../trpc";

type Row = Awaited<ReturnType<typeof trpc.analytics.getStats.query>>[number];

const days = ref(30);
const loading = ref(true);
const refreshing = ref(false);
const error = ref("");
const rows = ref<Row[]>([]);

const totalRequests = computed(() =>
  rows.value.reduce((s, r) => s + r.requestCount, 0),
);
const totalErrors = computed(() =>
  rows.value.reduce((s, r) => s + r.errorCount, 0),
);
const hostnames = computed(() => [...new Set(rows.value.map((r) => r.hostname))]);

const hostSummary = computed(() => {
  const map = new Map<string, { requests: number; errors: number }>();
  for (const r of rows.value) {
    const cur = map.get(r.hostname) ?? { requests: 0, errors: 0 };
    cur.requests += r.requestCount;
    cur.errors += r.errorCount;
    map.set(r.hostname, cur);
  }
  return [...map.entries()]
    .map(([hostname, c]) => ({
      hostname,
      requests: c.requests,
      errors: c.errors,
      errorRate: c.requests > 0 ? (c.errors / c.requests) * 100 : 0,
    }))
    .sort((a, b) => b.requests - a.requests);
});

const dailySummary = computed(() => {
  const map = new Map<string, { requests: number; errors: number }>();
  for (const r of rows.value) {
    const cur = map.get(r.date) ?? { requests: 0, errors: 0 };
    cur.requests += r.requestCount;
    cur.errors += r.errorCount;
    map.set(r.date, cur);
  }
  return [...map.entries()]
    .map(([date, c]) => ({ date, requests: c.requests, errors: c.errors }))
    .sort((a, b) => b.date.localeCompare(a.date));
});

async function fetchStats() {
  loading.value = true;
  error.value = "";
  try {
    rows.value = await trpc.analytics.getStats.query({ days: days.value });
  } catch (e: unknown) {
    error.value = (e as { message?: string })?.message ?? "Failed to load";
  } finally {
    loading.value = false;
  }
}

async function refresh() {
  refreshing.value = true;
  error.value = "";
  try {
    await trpc.analytics.refresh.mutate();
    await fetchStats();
  } catch (e: unknown) {
    error.value = (e as { message?: string })?.message ?? "Refresh failed";
  } finally {
    refreshing.value = false;
  }
}

onMounted(fetchStats);
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

.header-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.days-select {
  background: var(--bg-input);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  color: var(--text-default);
  font-size: var(--font-small);
  padding: 0.35rem 0.6rem;
  cursor: pointer;
}

.summary-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1rem;
  margin-bottom: 2rem;
}

.summary-card {
  background: var(--bg-card);
  border: 1px solid var(--border-default);
  border-radius: 10px;
  padding: 1.25rem 1.5rem;
}

.summary-value {
  font-size: 1.8rem;
  font-weight: 700;
  line-height: 1.1;
  margin-bottom: 0.3rem;
}

.summary-label {
  font-size: var(--font-tiny);
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.section-title {
  font-size: var(--font-small);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  margin-bottom: 0.75rem;
  margin-top: 1.5rem;
}

.table-wrap {
  background: var(--bg-card);
  border: 1px solid var(--border-default);
  border-radius: 10px;
  overflow: hidden;
  margin-bottom: 1.5rem;
}

.stats-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--font-small);
}

.stats-table th,
.stats-table td {
  padding: 0.65rem 1rem;
  text-align: left;
}

.stats-table th {
  background: var(--bg-input);
  font-weight: 600;
  font-size: var(--font-tiny);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  border-bottom: 1px solid var(--border-default);
}

.stats-table tbody tr + tr {
  border-top: 1px solid var(--border-subtle);
}

.stats-table .num {
  text-align: right;
}

.hostname {
  font-family: monospace;
  font-size: 0.85rem;
}

.rate-ok {
  color: var(--status-ok-text);
}
.rate-mid {
  color: var(--status-warn-text);
}
.rate-high {
  color: var(--status-err-text);
}

.empty-state {
  text-align: center;
  padding: 4rem 2rem;
  color: var(--text-muted);
}

.empty-state .hint {
  font-size: var(--font-small);
  max-width: 380px;
  margin: 0.5rem auto 0;
  line-height: 1.6;
}

.alert.error {
  background: var(--status-err-bg);
  border: 1px solid var(--status-err-border);
  color: var(--status-err-text);
  border-radius: 6px;
  padding: 0.6rem 0.75rem;
  margin-bottom: 1rem;
}

.btn-secondary {
  background: var(--bg-input);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  color: var(--text-default);
  font-size: var(--font-small);
  padding: 0.35rem 0.75rem;
  cursor: pointer;
  transition:
    border-color 0.15s,
    background 0.15s;
}

.btn-secondary:hover:not(:disabled) {
  border-color: var(--brand);
}

.btn-secondary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
