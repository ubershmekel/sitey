<template>
  <Layout>
    <div class="page-head">
      <h1>Analytics</h1>
      <p class="subtitle">
        Request traffic per service — approximate, best-effort. No charts, no
        cookies, no per-visitor data.
      </p>
    </div>

    <div v-if="loadError" class="alert error">{{ loadError }}</div>

    <div class="controls">
      <label class="control">
        <span class="control-label">Service</span>
        <select v-model.number="selectedId" class="select" @change="onSelect">
          <option v-for="s in serviceOptions" :key="s.id" :value="s.id">
            {{ s.label }}
          </option>
        </select>
      </label>
    </div>

    <!-- ── Headline counters ─────────────────────────────────────── -->
    <div class="stat-grid">
      <div class="stat-card">
        <span class="stat-label">Requests (all time)</span>
        <span class="stat-value">{{ fmtNum(headline.totalRequests) }}</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">Requests (7 days)</span>
        <span class="stat-value">{{ fmtNum(headline.last7dRequests) }}</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">Errors 5xx (7 days)</span>
        <span class="stat-value">{{ fmtNum(headline.last7dErrors) }}</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">Bandwidth (7 days)</span>
        <span class="stat-value">{{ fmtBytes(headline.last7dBytes) }}</span>
      </div>
    </div>

    <!-- ── Top paths ─────────────────────────────────────────────── -->
    <div class="section">
      <h2>Top paths</h2>
      <p class="section-hint">Most-requested URLs in the last 7 days.</p>
      <div v-if="detailLoading" class="state-msg">Loading…</div>
      <div v-else-if="detail.topPaths.length === 0" class="empty-msg">
        No traffic recorded yet.
      </div>
      <table v-else class="data-table">
        <thead>
          <tr>
            <th>Path</th>
            <th class="num">Requests</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, i) in detail.topPaths" :key="i">
            <td class="mono path">
              <span class="host">{{ row.host }}</span
              >{{ row.path || "/" }}
            </td>
            <td class="num">{{ fmtNum(row.count) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- ── Errors ────────────────────────────────────────────────── -->
    <div class="section">
      <div class="section-head-row">
        <h2>Top status codes</h2>
        <div class="toggle">
          <button
            type="button"
            class="toggle-btn"
            :class="{ active: statusFilter === 'all' }"
            @click="setStatusFilter('all')"
          >
            All errors (≥400)
          </button>
          <button
            type="button"
            class="toggle-btn"
            :class="{ active: statusFilter === '404' }"
            @click="setStatusFilter('404')"
          >
            404s
          </button>
        </div>
      </div>
      <p class="section-hint">Which URLs returned errors in the last 7 days.</p>
      <div v-if="detailLoading" class="state-msg">Loading…</div>
      <div v-else-if="detail.topErrors.length === 0" class="empty-msg">
        No errors recorded — nice.
      </div>
      <table v-else class="data-table">
        <thead>
          <tr>
            <th class="num status-col">Status</th>
            <th>Path</th>
            <th class="num">Count</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, i) in detail.topErrors" :key="i">
            <td class="num">
              <span :class="['code-badge', codeClass(row.status)]">{{
                row.status
              }}</span>
            </td>
            <td class="mono path">
              <span class="host">{{ row.host }}</span
              >{{ row.path || "/" }}
            </td>
            <td class="num">{{ fmtNum(row.count) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </Layout>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import Layout from "../components/Layout.vue";
import { trpc } from "../trpc";

type Headline = Awaited<ReturnType<typeof trpc.analytics.forService.query>>;
type Detail = Awaited<ReturnType<typeof trpc.analytics.detail.query>>;

const route = useRoute();
const router = useRouter();

const serviceOptions = ref<Array<{ id: number; label: string }>>([]);
const selectedId = ref<number>(0);
const statusFilter = ref<"all" | "404">("all");

const headline = ref<Headline>({
  totalRequests: 0,
  last7dRequests: 0,
  last7dErrors: 0,
  last7dBytes: 0,
});
const detail = ref<Detail>({ topPaths: [], topErrors: [] });
const detailLoading = ref(false);
const loadError = ref("");

async function loadServices() {
  try {
    const services = await trpc.services.list.query();
    // The built-in protected "sitey" service is the control panel itself — its
    // traffic is tagged with its real id (see caddy.ts), so it appears here
    // like any other service. No separate synthetic "Admin panel" entry.
    const opts = services.map((s) => ({ id: s.id, label: s.name }));
    // Synthetic "Unknown" bucket (service id 0): traffic not attributable to any
    // user service — fallthrough 404s on unmatched paths, plus any line that
    // reached ingest untagged. Kept last so it never becomes the default
    // selection. id 0 never collides with a real service (they autoincrement
    // from 1); see UNKNOWN_SERVICE_ID in server constants / docs/design/analytics.md.
    opts.push({ id: 0, label: "Requests without service ID" });
    serviceOptions.value = opts;

    const fromQuery = Number(route.query.service);
    if (Number.isFinite(fromQuery) && opts.some((o) => o.id === fromQuery)) {
      selectedId.value = fromQuery;
    } else {
      selectedId.value = opts[0]?.id ?? 0;
    }
  } catch (e: unknown) {
    loadError.value =
      (e as { message?: string })?.message ?? "Failed to load services";
  }
}

async function loadData() {
  detailLoading.value = true;
  try {
    const [h, d] = await Promise.all([
      trpc.analytics.forService.query({ serviceId: selectedId.value }),
      trpc.analytics.detail.query({
        serviceId: selectedId.value,
        days: 7,
        ...(statusFilter.value === "404" ? { status: 404 } : {}),
      }),
    ]);
    headline.value = h;
    detail.value = d;
  } catch (e: unknown) {
    loadError.value =
      (e as { message?: string })?.message ?? "Failed to load analytics";
  } finally {
    detailLoading.value = false;
  }
}

function onSelect() {
  router.replace({
    query: { ...route.query, service: String(selectedId.value) },
  });
  loadData();
}

function setStatusFilter(f: "all" | "404") {
  if (statusFilter.value === f) return;
  statusFilter.value = f;
  loadData();
}

function fmtNum(n: number): string {
  return new Intl.NumberFormat().format(n ?? 0);
}

function fmtBytes(n: number): string {
  const bytes = n ?? 0;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function codeClass(status: number): string {
  if (status >= 500) return "code-5xx";
  if (status >= 400) return "code-4xx";
  return "code-ok";
}

onMounted(async () => {
  await loadServices();
  await loadData();
});
</script>

<style scoped>
.page-head {
  margin-bottom: 1.5rem;
}

h1 {
  font-weight: 600;
}

.subtitle {
  font-size: var(--font-tiny);
  color: var(--text-muted);
  margin-top: 0.25rem;
}

.controls {
  margin-bottom: 1.5rem;
}

.control {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  max-width: 320px;
}

.control-label {
  font-size: var(--font-tiny);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}

.select {
  background: var(--bg-input);
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  padding: 0.5rem 0.6rem;
  font-size: var(--font-small);
  color: inherit;
}

/* ── Stat grid ── */
.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 0.75rem;
  margin-bottom: 2rem;
}

.stat-card {
  background: var(--bg-card);
  border: 1px solid var(--border-default);
  border-radius: 10px;
  padding: 1rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.stat-label {
  font-size: var(--font-tiny);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}

.stat-value {
  font-size: var(--font-large);
  font-weight: 700;
}

/* ── Sections ── */
.section {
  margin-bottom: 2rem;
}

.section h2 {
  font-size: var(--font-medium);
  font-weight: 600;
  margin-bottom: 0.35rem;
}

.section-head-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}

.section-hint {
  font-size: var(--font-tiny);
  color: var(--text-muted);
  margin-bottom: 1rem;
}

.empty-msg,
.state-msg {
  font-size: var(--font-tiny);
  color: var(--text-muted);
}

/* ── Toggle ── */
.toggle {
  display: flex;
  gap: 2px;
  background: var(--bg-input);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  padding: 2px;
}

.toggle-btn {
  background: none;
  border: none;
  border-radius: 4px;
  padding: 0.3rem 0.6rem;
  font-size: var(--font-tiny);
  cursor: pointer;
  color: var(--text-secondary);
}

.toggle-btn.active {
  background: var(--brand-active-bg);
  color: var(--brand-active-text);
}

/* ── Table ── */
.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--font-tiny);
}

.data-table th,
.data-table td {
  text-align: left;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--border-subtle);
}

.data-table th {
  font-size: var(--font-tiny);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  font-weight: 500;
}

.data-table .num {
  text-align: right;
  white-space: nowrap;
}

.status-col {
  width: 80px;
}

.mono {
  font-family: monospace;
}

.path {
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 0;
  white-space: nowrap;
  word-break: break-all;
}

.host {
  color: var(--text-muted);
}

.code-badge {
  display: inline-block;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  font-weight: 600;
}

.code-4xx {
  background: var(--status-warn-bg);
  color: var(--status-warn-text);
}

.code-5xx {
  background: var(--status-err-bg);
  color: var(--status-err-text);
}

.code-ok {
  background: var(--status-idle-bg);
  color: var(--status-idle-text);
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
