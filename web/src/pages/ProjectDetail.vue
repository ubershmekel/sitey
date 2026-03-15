<template>
  <Layout>
    <div v-if="loading" class="state-msg">Loading...</div>
    <div v-else-if="error" class="alert error">{{ error }}</div>
    <template v-else-if="project">
      <div class="breadcrumb">
        <RouterLink to="/projects">Projects</RouterLink>
        <template v-if="primaryDomainRoute?.domain">
          /
          <RouterLink :to="`/domains/${primaryDomainRoute.domain.id}`">
            {{ primaryDomainRoute.domain.hostname }}
          </RouterLink>
        </template>
        / {{ project.name }}
      </div>

      <!-- ── Hero card ─────────────────────────────────────────────── -->
      <div class="hero-card">
        <div class="hero-top">
          <div class="hero-name-row">
            <h1>111{{ project.name }}</h1>
            <span :class="`status status-${project.status}`"
              >1111{{
                containerLabel(project.status, project.deployMode)
              }}</span
            >
          </div>
          <button
            class="btn-primary"
            :disabled="deploying"
            @click="triggerDeploy"
          >
            {{ deploying ? "Deploying..." : "Deploy now" }}
          </button>
        </div>

        <div v-if="projectUrl" class="hero-url">
          <a
            :href="projectUrl"
            target="_blank"
            rel="noopener"
            class="url-https"
            >{{ projectUrl }}</a
          >
          <span class="url-sep">·</span>
          <a
            :href="projectUrl.replace('https://', 'http://')"
            target="_blank"
            rel="noopener"
            class="url-http"
            >http</a
          >
        </div>
        <div v-else-if="fallbackUrl" class="hero-url hint">
          No domain route yet — fallback: <code>{{ fallbackUrl }}</code>
        </div>
        <div v-else class="hero-url hint">No route assigned yet.</div>

        <div v-if="deployError" class="alert error" style="margin-top: 0.75rem">
          {{ deployError }}
        </div>
        <div
          v-if="project.status === 'failed'"
          class="deploy-notice deploy-notice-failed"
        >
          Last deploy failed — check build logs below.
        </div>
        <div
          v-else-if="
            project.status === 'building' || project.status === 'queued'
          "
          class="deploy-notice deploy-notice-building"
        >
          Deploy in progress — site will update once it finishes.
        </div>
      </div>

      <!-- ── Info grid ─────────────────────────────────────────────── -->
      <div class="info-grid">
        <div class="info-card">
          <div class="info-label">Repository</div>
          <div class="info-value mono">
            {{ project.repoOwner }}/{{ project.repoName }}:{{ project.branch }}
          </div>
        </div>
        <div class="info-card">
          <div class="info-label">Deploy type</div>
          <div class="info-value">{{ deployTypeLabel }}</div>
        </div>
        <div v-if="project.deployMode === 'server'" class="info-card">
          <div class="info-label">Container port</div>
          <div class="info-value mono">{{ project.containerPort }}</div>
        </div>
        <div class="info-card">
          <div class="info-label">GitHub</div>
          <div class="info-value">
            {{ project.githubMode === "app" ? "GitHub App" : "Webhook" }}
          </div>
        </div>
      </div>

      <!-- ── Routes ────────────────────────────────────────────────── -->
      <div class="section">
        <h2>Routes</h2>
        <p class="section-hint">
          Each route maps a domain (or path prefix) to this project.
        </p>

        <div v-if="project.routes.length === 0" class="empty-msg">
          No domain routes yet — add one below.
        </div>
        <div v-else class="route-list">
          <div v-for="r in project.routes" :key="r.id" class="route-row">
            <div class="route-url-wrap">
              <a
                v-if="routeIsHttps(r)"
                :href="routeLabel(r)"
                target="_blank"
                rel="noopener"
                class="route-url mono route-url-link"
                >{{ routeLabel(r) }}</a
              >
              <span v-else class="route-url mono">{{ routeLabel(r) }}</span>
            </div>
            <div class="route-meta">
              <span
                v-if="r.domain?.hostname.startsWith('*.')"
                class="route-badge"
                >wildcard</span
              >
              <span v-if="r.pathPrefix" class="route-badge">path</span>
            </div>
            <button
              class="btn-ghost-sm"
              :disabled="routeSaving || r.protected"
              @click="removeRoute(r.id)"
            >
              {{ r.protected ? "Protected" : "Remove" }}
            </button>
          </div>
        </div>

        <div class="add-route-box">
          <div class="add-route-title">Add route</div>
          <form
            class="route-form"
            :style="
              isWildcardSelected
                ? 'grid-template-columns: 1fr 1fr 1fr auto'
                : ''
            "
            @submit.prevent="addRoute"
          >
            <label>
              Domain
              <select
                v-model="newRoute.domainId"
                required
                @change="onDomainChange"
              >
                <option value="">Select domain</option>
                <option v-for="d in domains" :key="d.id" :value="d.id">
                  {{ d.hostname }}
                </option>
              </select>
            </label>
            <label v-if="isWildcardSelected">
              Subdomain <span class="hint">(e.g. myapp)</span>
              <div class="subdomain-input-wrap">
                <input
                  v-model="newRoute.subdomain"
                  type="text"
                  placeholder="auto"
                  class="subdomain-input"
                />
                <span class="subdomain-suffix">.{{ selectedDomainBase }}</span>
              </div>
            </label>
            <label>
              Path prefix <span class="hint">(optional)</span>
              <input
                v-model="newRoute.pathPrefix"
                type="text"
                placeholder="/"
              />
            </label>
            <button
              class="btn-primary"
              type="submit"
              :disabled="routeSaving || !newRoute.domainId"
            >
              {{ routeSaving ? "Saving..." : "Add route" }}
            </button>
          </form>
          <div v-if="routeError" class="alert error mt-1">{{ routeError }}</div>
        </div>
      </div>

      <!-- ── GitHub Webhook setup ───────────────────────────────────── -->
      <div v-if="project.githubMode === 'webhook'" class="webhook-card">
        <h2>GitHub Webhook Setup</h2>
        <p class="hint">
          Add this webhook in your GitHub repo settings to auto-deploy on push.
        </p>
        <p v-if="webhookError" class="hint webhook-error">{{ webhookError }}</p>
        <template v-if="webhookInfo">
          <div v-if="webhookInfo.domains.length > 1" class="webhook-row">
            <span class="wh-label">Domain</span>
            <select
              v-model="webhookDomainId"
              @change="refetchWebhookInfo"
              class="domain-select"
            >
              <option
                v-for="d in webhookInfo.domains"
                :key="d.id"
                :value="d.id"
              >
                {{ d.hostname }}
              </option>
            </select>
          </div>
          <div class="webhook-row">
            <span class="wh-label">Payload URL</span>
            <code>{{ webhookInfo.webhookUrl }}</code>
            <button class="btn-copy" @click="copy(webhookInfo.webhookUrl)">
              Copy
            </button>
          </div>
          <div class="webhook-row">
            <span class="wh-label">Secret</span>
            <code>{{ webhookInfo.webhookSecret }}</code>
            <button
              class="btn-copy"
              @click="copy(webhookInfo.webhookSecret ?? '')"
            >
              Copy
            </button>
          </div>
          <button class="btn-ghost mt-1" @click="rotateSecret">
            Rotate secret
          </button>
        </template>
      </div>

      <!-- ── Build deployments ─────────────────────────────────────── -->
      <div class="section">
        <h2>Deployments</h2>
        <div v-if="project.deployments.length === 0" class="empty-msg">
          No deployments yet.
        </div>
        <div v-else class="deploy-list">
          <div
            v-for="d in project.deployments"
            :key="d.id"
            class="deploy-row"
            :class="{ active: selectedDeployId === d.id }"
            @click="selectDeploy(d.id)"
          >
            <span :class="`status status-${d.status}`">{{ d.status }}</span>
            <span class="deploy-sha mono">{{
              d.commitSha?.slice(0, 8) ?? "-"
            }}</span>
            <span class="deploy-msg">{{
              d.commitMessage?.slice(0, 60) ?? ""
            }}</span>
            <span class="deploy-time">{{ relativeTime(d.createdAt) }}</span>
            <span class="deploy-trigger">{{ d.triggeredBy }}</span>
          </div>
        </div>

        <div v-if="selectedDeployId" class="log-section">
          <div class="log-header">
            <h3>Build logs</h3>
            <button
              type="button"
              class="btn-ghost-sm"
              :disabled="logsLoading"
              @click="refreshLogs"
            >
              {{ logsLoading ? "Refreshing..." : "Refresh" }}
            </button>
          </div>
          <div class="log-box" ref="logBox">
            <div v-if="logLines.length === 0" class="log-empty">
              No logs yet.
            </div>
            <pre v-else class="log-content">{{ logLines.join("\n") }}</pre>
          </div>
        </div>
      </div>

      <!-- ── Docker container logs ─────────────────────────────────── -->
      <div v-if="project.deployMode === 'server'" class="section">
        <h2>Docker logs</h2>
        <p class="section-hint">
          View live container output in the
          <RouterLink
            :to="`/logs?container=sitey-${project.id}`"
            class="logs-link"
            >Logs tab</RouterLink
          >.
        </p>
      </div>

      <!-- ── Danger zone ───────────────────────────────────────────── -->
      <div class="danger-zone">
        <h2>Danger zone</h2>
        <p class="danger-desc">
          Deleting this project stops the container and removes all files. This
          cannot be undone.
        </p>
        <button class="btn-danger" :disabled="deleting" @click="deleteProject">
          {{ deleting ? "Deleting..." : "Delete project" }}
        </button>
      </div>
    </template>
  </Layout>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from "vue";
import { useRoute, useRouter, RouterLink } from "vue-router";
import Layout from "../components/Layout.vue";
import { trpc } from "../trpc";

type Project = Awaited<ReturnType<typeof trpc.projects.get.query>>;
type ProjectRoute = Project["routes"][number];
type WebhookInfo = Awaited<
  ReturnType<typeof trpc.projects.getWebhookInfo.query>
>;
type Domain = Awaited<ReturnType<typeof trpc.domains.list.query>>[number];

const route = useRoute();
const router = useRouter();
const projectId = Number(route.params.id);

const project = ref<Project | null>(null);
const domains = ref<Pick<Domain, "id" | "hostname">[]>([]);
const loading = ref(true);
const error = ref("");
const deploying = ref(false);
const deployError = ref("");
const deleting = ref(false);
const routeSaving = ref(false);
const routeError = ref("");
const webhookInfo = ref<WebhookInfo | null>(null);
const webhookError = ref("");
const webhookDomainId = ref<number | null>(null);
const selectedDeployId = ref<string | null>(null);
const logLines = ref<string[]>([]);
const logBox = ref<HTMLElement | null>(null);
const logsLoading = ref(false);
const LOG_POLL_MS = 3000;
let logPollTimer: ReturnType<typeof setInterval> | null = null;

const newRoute = ref({
  domainId: null as number | null,
  pathPrefix: "",
  subdomain: "",
});

const isWildcardSelected = computed(() => {
  if (!newRoute.value.domainId) return false;
  const d = domains.value.find((x) => x.id === newRoute.value.domainId);
  return d?.hostname.startsWith("*.") ?? false;
});

const selectedDomainBase = computed(() => {
  const d = domains.value.find((x) => x.id === newRoute.value.domainId);
  if (!d?.hostname.startsWith("*.")) return "";
  return d.hostname.slice(2);
});

function onDomainChange() {
  newRoute.value.subdomain = "";
}

const primaryDomainRoute = computed(
  () => project.value?.routes.find((r) => !!r.domain) ?? null,
);

function routeHostname(r: ProjectRoute): string {
  if (!r.domain?.hostname) return "";
  if (!r.domain.hostname.startsWith("*.")) return r.domain.hostname;
  return r.subdomain
    ? `${r.subdomain}.${r.domain.hostname.slice(2)}`
    : r.domain.hostname;
}

const projectUrl = computed(() => {
  const r = primaryDomainRoute.value;
  if (!r?.domain) return "";
  return `https://${routeHostname(r)}${r.pathPrefix || ""}`;
});

const fallbackUrl = computed(() => {
  if (!project.value?.hostPort) return "";
  return `http://<server-ip>:${project.value.hostPort}`;
});

const deployTypeLabel = computed(() => {
  if (!project.value) return "";
  if (project.value.deployMode === "static") return "Static site";
  if (project.value.buildMode === "dockerfile") {
    const p = project.value.dockerfilePath || "Dockerfile";
    return p === "Dockerfile" ? "Dockerfile" : `Dockerfile (${p})`;
  }
  return "Server app";
});

const selectedDeployment = computed(
  () =>
    project.value?.deployments.find((d) => d.id === selectedDeployId.value) ??
    null,
);

const shouldAutoRefreshLogs = computed(() => {
  if (!selectedDeployId.value) return false;
  const status = selectedDeployment.value?.status ?? project.value?.status;
  return status === "building" || status === "queued";
});

function normalizePathPrefix(input: string): string {
  const raw = input.trim();
  if (!raw || raw === "/") return "";
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function routeLabel(r: ProjectRoute): string {
  const pathPrefix = r.pathPrefix || "";
  const hostname = routeHostname(r);
  if (hostname) {
    return `https://${hostname}${pathPrefix}`;
  }
  return pathPrefix ? `<server>${pathPrefix}` : "<server>";
}

function routeIsHttps(r: ProjectRoute): boolean {
  return !!r.domain?.hostname;
}

async function fetchProject() {
  loading.value = true;
  error.value = "";
  try {
    const [proj, domainList] = await Promise.all([
      trpc.projects.get.query({ id: projectId }),
      trpc.domains.list.query(),
    ]);
    project.value = proj;
    domains.value = domainList.map((d) => ({ id: d.id, hostname: d.hostname }));
    if (!newRoute.value.domainId && domains.value.length === 1) {
      newRoute.value.domainId = domains.value[0].id;
    }

    if (project.value.githubMode === "webhook") {
      await refetchWebhookInfo();
    } else {
      webhookInfo.value = null;
      webhookDomainId.value = null;
    }

    if (project.value.deployments[0]) {
      selectedDeployId.value = project.value.deployments[0].id;
      await fetchLogs();
    } else {
      selectedDeployId.value = null;
      logLines.value = [];
    }
  } catch (e: unknown) {
    error.value =
      (e as { message?: string })?.message ?? "Failed to load project";
  } finally {
    loading.value = false;
  }
}

async function addRoute() {
  if (!newRoute.value.domainId) return;
  routeSaving.value = true;
  routeError.value = "";
  try {
    await trpc.projects.addRoute.mutate({
      projectId,
      domainId: newRoute.value.domainId ?? undefined,
      pathPrefix: normalizePathPrefix(newRoute.value.pathPrefix),
      subdomain: newRoute.value.subdomain.trim().toLowerCase(),
    });
    newRoute.value.pathPrefix = "";
    newRoute.value.subdomain = "";
    await fetchProject();
  } catch (e: unknown) {
    routeError.value =
      (e as { message?: string })?.message ?? "Failed to add route";
  } finally {
    routeSaving.value = false;
  }
}

async function removeRoute(routeId: string) {
  if (!confirm("Remove this route?")) return;
  routeSaving.value = true;
  routeError.value = "";
  try {
    await trpc.projects.removeRoute.mutate({ routeId });
    await fetchProject();
  } catch (e: unknown) {
    routeError.value =
      (e as { message?: string })?.message ?? "Failed to remove route";
  } finally {
    routeSaving.value = false;
  }
}

async function triggerDeploy() {
  deploying.value = true;
  deployError.value = "";
  try {
    const res = await trpc.deploy.trigger.mutate({
      projectId,
      triggeredBy: "manual",
    });
    selectedDeployId.value = res.deploymentId;
    await fetchProject();
  } catch (e: unknown) {
    deployError.value = (e as { message?: string })?.message ?? "Deploy failed";
  } finally {
    deploying.value = false;
  }
}

async function selectDeploy(id: string) {
  selectedDeployId.value = id;
  await fetchLogs();
}

async function fetchLogs() {
  if (!selectedDeployId.value || logsLoading.value) return;
  logsLoading.value = true;
  try {
    const res = await trpc.deploy.getLogs.query({
      deploymentId: selectedDeployId.value,
    });
    logLines.value = res.lines;
    await nextTick();
    if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight;
  } finally {
    logsLoading.value = false;
  }
}

async function refreshLogs() {
  await fetchLogs();
}

function startLogPolling() {
  if (logPollTimer) return;
  logPollTimer = setInterval(() => {
    void fetchLogs();
  }, LOG_POLL_MS);
}

function stopLogPolling() {
  if (!logPollTimer) return;
  clearInterval(logPollTimer);
  logPollTimer = null;
}

async function refetchWebhookInfo() {
  webhookError.value = "";
  try {
    const info = await trpc.projects.getWebhookInfo.query({
      id: projectId,
      ...(webhookDomainId.value ? { domainId: webhookDomainId.value } : {}),
    });
    webhookInfo.value = info;
  } catch (e: unknown) {
    webhookInfo.value = null;
    webhookError.value =
      (e as { message?: string })?.message ?? "Could not resolve webhook URL.";
  }
}

async function deleteProject() {
  if (
    !confirm(
      `Delete project "${project.value?.name}"? This will stop the container and remove all files.`,
    )
  )
    return;
  deleting.value = true;
  try {
    await trpc.projects.delete.mutate({ id: projectId });
    router.push("/");
  } catch (e: unknown) {
    alert((e as { message?: string })?.message ?? "Failed to delete project");
    deleting.value = false;
  }
}

async function rotateSecret() {
  if (!confirm("Rotate webhook secret? You will need to update GitHub."))
    return;
  const res = await trpc.projects.rotateWebhookSecret.mutate({ id: projectId });
  if (webhookInfo.value) webhookInfo.value.webhookSecret = res.webhookSecret;
}

function copy(text: string) {
  navigator.clipboard.writeText(text);
}

function containerLabel(status: string, deployMode: string) {
  if (deployMode === "static") {
    const labels: Record<string, string> = {
      idle: "Deployed",
      building: "Building…",
      queued: "Queued",
      failed: "Deploy failed",
    };
    return labels[status] ?? status;
  }
  const labels: Record<string, string> = {
    idle: "Not started",
    building: "Building…",
    queued: "Queued",
    running: "Running",
    failed: "Failed",
    stopped: "Stopped",
  };
  return labels[status] ?? status;
}

function relativeTime(ts: string | Date) {
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

onMounted(async () => {
  await fetchProject();
});
watch(
  shouldAutoRefreshLogs,
  (enabled) => {
    if (enabled) {
      startLogPolling();
      return;
    }
    stopLogPolling();
  },
  { immediate: true },
);
onUnmounted(stopLogPolling);
</script>

<style scoped>
.breadcrumb {
  font-size: var(--font-tiny);
  margin-bottom: 0.75rem;
}

.breadcrumb a {
  color: var(--brand);
  text-decoration: none;
}

.breadcrumb a:hover {
  text-decoration: underline;
}

/* ── Hero card ────────────────────────────────────────────────── */
.hero-card {
  background: var(--bg-card);
  border: 1px solid var(--border-default);
  border-radius: 12px;
  padding: 1.5rem;
  margin-bottom: 1.5rem;
}

.hero-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 0.75rem;
}

.hero-name-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}

h1 {
  font-weight: 600;
}

.hero-url {
  margin-bottom: 0.25rem;
}

.url-https {
  color: var(--brand);
  text-decoration: none;
  font-weight: 500;
}

.url-https:hover {
  text-decoration: underline;
}

.url-sep {
  margin: 0 0.35rem;
}

.url-http {
  font-size: var(--font-tiny);
  text-decoration: none;
}

.url-http:hover {
  text-decoration: underline;
}

.deploy-notice {
  font-size: var(--font-tiny);
  margin-top: 0.5rem;
  padding: 0.25rem 0.6rem;
  border-radius: 4px;
  display: inline-block;
}

.deploy-notice-failed {
  background: var(--status-err-bg);
  color: var(--status-err-text);
}

.deploy-notice-building {
  background: var(--status-info-bg);
  color: var(--status-info-text);
}

/* ── Info grid ───────────────────────────────────────────────── */
.info-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 0.75rem;
  margin-bottom: 2rem;
}

.info-card {
  background: var(--bg-card);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  padding: 0.85rem 1rem;
}

.info-label {
  font-size: var(--font-tiny);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 0.3rem;
}

.mono {
  font-family: monospace;
}

/* ── Sections ───────────────────────────────────────────────── */
.section {
  margin-bottom: 2rem;
}

.section h2 {
  font-size: var(--font-medium);
  font-weight: 600;
  margin-bottom: 0.35rem;
}

.section-hint {
  font-size: var(--font-tiny);
  margin-bottom: 1rem;
}

.empty-msg {
  font-size: var(--font-tiny);
  margin-bottom: 1rem;
}

/* ── Route list ─────────────────────────────────────────────── */
.route-list {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  margin-bottom: 1.25rem;
}

.route-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  background: var(--bg-card);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  padding: 0.55rem 0.75rem;
}

.route-url-wrap {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  min-width: 0;
}

.route-url {
  color: var(--status-info-text);
  font-size: var(--font-tiny);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.route-url-link {
  color: var(--status-info-text);
  text-decoration: none;
}

.route-url-link:hover {
  text-decoration: underline;
  color: var(--brand);
}

.route-meta {
  display: flex;
  gap: 0.35rem;
  flex-shrink: 0;
}

.route-badge {
  font-size: var(--font-tiny);
  padding: 0.1rem 0.4rem;
  border-radius: 3px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
}

/* ── Add route box ──────────────────────────────────────────── */
.add-route-box {
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  padding: 1rem;
}

.add-route-title {
  font-size: var(--font-tiny);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 0.75rem;
}

.route-form {
  display: grid;
  grid-template-columns: 1fr 1fr auto;
  gap: 0.75rem;
  align-items: end;
}

.subdomain-input-wrap {
  display: flex;
  align-items: center;
  background: var(--bg-input);
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  overflow: hidden;
  transition: border-color 0.15s;
}

.subdomain-input-wrap:focus-within {
  border-color: var(--brand);
}

.subdomain-input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  border-radius: 0;
  padding: 0.6rem 0.4rem 0.6rem 0.75rem;
}

.subdomain-input:focus {
  border-color: transparent;
}

.subdomain-suffix {
  font-size: var(--font-tiny);
  padding: 0 0.6rem 0 0;
  white-space: nowrap;
  font-family: monospace;
}

/* ── Webhook ────────────────────────────────────────────────── */
.webhook-card {
  background: var(--bg-card);
  border: 1px solid var(--border-default);
  border-radius: 10px;
  padding: 1.5rem;
  margin-bottom: 2rem;
}

.webhook-card h2 {
  font-size: var(--font-medium);
  font-weight: 600;
  margin-bottom: 0.5rem;
}

.hint {
  margin-bottom: 1rem;
}

.webhook-error {
  color: var(--status-warn-text);
}

.webhook-row {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--border-subtle);
}

.wh-label {
  font-size: var(--font-tiny);
  min-width: 100px;
}

code {
  background: var(--bg-input);
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  font-family: monospace;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.btn-copy {
  background: none;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  padding: 0.2rem 0.5rem;
  font-size: var(--font-tiny);
  cursor: pointer;
  transition:
    border-color 0.15s,
    color 0.15s;
}

.btn-copy:hover {
  border-color: var(--text-muted);
}

/* ── Deployments ───────────────────────────────────────────── */
.deploy-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 1rem;
}

.deploy-row {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.6rem 1rem;
  border-radius: 6px;
  cursor: pointer;
  background: var(--bg-card);
  border: 1px solid var(--border-default);
  transition: border-color 0.15s;
}

.deploy-row:hover {
  border-color: var(--border-strong);
}

.deploy-row.active {
  border-color: var(--brand);
  background: var(--bg-hover);
}

.deploy-sha {
  font-family: monospace;
  font-size: var(--font-tiny);
  min-width: 70px;
}

.deploy-msg {
  flex: 1;
  font-size: var(--font-tiny);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.deploy-time {
  font-size: var(--font-tiny);
  white-space: nowrap;
}

.deploy-trigger {
  font-size: var(--font-tiny);
  background: var(--bg-elevated);
  padding: 0.15rem 0.4rem;
  border-radius: 4px;
}

/* ── Log box ────────────────────────────────────────────────── */
.log-section {
  margin-top: 1rem;
}

.log-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 0.5rem;
}

.log-header h3 {
  font-size: var(--font-huge);
  font-weight: 600;
}

.log-box {
  background: var(--bg-code);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  padding: 1rem;
  max-height: 400px;
  overflow-y: auto;
  font-family: monospace;
  font-size: var(--font-tiny);
  line-height: 1.5;
}

.log-content {
  color: var(--status-ok-text);
  white-space: pre-wrap;
  word-break: break-all;
}

/* ── Status badges ──────────────────────────────────────────── */
.status {
  font-size: var(--font-tiny);
  padding: 0.2rem 0.5rem;
  border-radius: 4px;
  font-weight: 500;
  white-space: nowrap;
}

.status-queued {
  background: var(--status-queued-bg);
  color: var(--status-queued-text);
}

.status-building {
  background: var(--status-info-bg);
  color: var(--status-info-text);
}

.status-running {
  background: var(--status-ok-bg);
  color: var(--status-ok-text);
}

.status-success {
  background: var(--status-ok-bg);
  color: var(--status-ok-text);
}

.status-failed {
  background: var(--status-err-bg);
  color: var(--status-err-text);
}

.status-idle {
  background: var(--status-idle-bg);
  color: var(--status-idle-text);
}

.status-stopped {
  background: var(--status-idle-bg);
  color: var(--status-idle-text);
}

/* ── Misc ───────────────────────────────────────────────────── */
.alert.error {
  background: var(--status-err-bg);
  border: 1px solid var(--status-err-border);
  color: var(--status-err-text);
  border-radius: 6px;
  padding: 0.6rem 0.75rem;
  margin-bottom: 1rem;
}

.mt-1 {
  margin-top: 1rem;
}

label {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

input,
select {
  background: var(--bg-input);
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  padding: 0.6rem 0.75rem;
  outline: none;
  transition: border-color 0.15s;
}

input:focus,
select:focus {
  border-color: var(--brand);
}

.btn-danger {
  background: var(--status-err-bg);
  color: var(--status-err-text);
  border: 1px solid var(--status-err-border);
  border-radius: 6px;
  padding: 0.6rem 1.25rem;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
}

.btn-danger:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-danger:hover:not(:disabled) {
  background: #4a1a1a;
  border-color: var(--status-err-border);
}

.btn-ghost {
  background: none;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  padding: 0.5rem 1rem;
  font-size: var(--font-tiny);
  cursor: pointer;
  transition:
    border-color 0.15s,
    color 0.15s;
}

.btn-ghost:hover {
  border-color: var(--text-muted);
}

.btn-ghost-sm {
  background: none;
  border: 1px solid var(--border-strong);
  border-radius: 5px;
  padding: 0.3rem 0.6rem;
  font-size: var(--font-tiny);
  cursor: pointer;
  transition:
    border-color 0.15s,
    color 0.15s;
  white-space: nowrap;
}

.danger-zone {
  margin-top: 3rem;
  padding-top: 1.5rem;
  border-top: 1px solid var(--border-default);
  margin-bottom: 2rem;
}

.danger-zone h2 {
  font-size: var(--font-medium);
  font-weight: 600;
  margin-bottom: 0.5rem;
  color: var(--status-err-text);
}

.danger-desc {
  font-size: var(--font-tiny);
  margin-bottom: 1rem;
}

.logs-link {
  color: var(--brand);
  text-decoration: none;
}

.logs-link:hover {
  text-decoration: underline;
}

.domain-select {
  background: var(--bg-input);
  border: 1px solid var(--border-strong);
  border-radius: 5px;
  padding: 0.3rem 0.5rem;
  font-size: var(--font-tiny);
  flex: 1;
}
</style>
