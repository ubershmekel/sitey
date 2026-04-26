<template>
  <Layout>
    <div v-if="loading" class="state-msg">Loading...</div>
    <div v-else-if="error" class="alert error">{{ error }}</div>
    <template v-else-if="service">
      <div class="breadcrumb">
        <RouterLink to="/services">Services</RouterLink>
        <template v-if="primaryDomainRoute?.domain">
          /
          <RouterLink :to="`/domains/${primaryDomainRoute.domain.id}`">
            {{ primaryDomainRoute.domain.hostname }}
          </RouterLink>
        </template>
        / {{ service.name }}
      </div>

      <!-- ── Hero card ─────────────────────────────────────────────── -->
      <div class="hero-card">
        <div class="hero-top">
          <div class="hero-name-row">
            <h1>{{ service.name }}</h1>
            <button
              type="button"
              class="btn-ghost-sm title-edit-btn"
              @click="startTitleEdit"
            >
              Edit name
            </button>
            <span v-if="!service.active" class="status status-inactive"
              >Inactive</span
            >
            <span v-else :class="`status status-${service.status}`">{{
              containerLabel(service.status, service.deployMode)
            }}</span>
          </div>
          <button
            class="btn-primary"
            :disabled="deploying || !service.active"
            @click="triggerDeploy"
          >
            {{ deploying ? "Deploying..." : "Deploy now" }}
          </button>
        </div>
        <form
          v-if="titleEditing"
          class="title-edit-form"
          @submit.prevent="saveTitleEdit"
        >
          <label>
            Service name
            <input
              v-model="titleDraft"
              type="text"
              required
              pattern="^[a-z0-9-]+$"
              maxlength="40"
              placeholder="my-service"
            />
          </label>
          <div class="title-edit-actions">
            <button
              type="submit"
              class="btn-primary"
              :disabled="titleSaving || !titleDirty"
            >
              {{ titleSaving ? "Saving..." : "Save name" }}
            </button>
            <button type="button" class="btn-ghost-sm" @click="cancelTitleEdit">
              Cancel
            </button>
            <span v-if="titleError" class="settings-error">{{
              titleError
            }}</span>
          </div>
        </form>

        <div v-if="serviceUrl" class="hero-url">
          <a
            :href="serviceUrl"
            target="_blank"
            rel="noopener"
            :class="
              primaryDomainRoute?.tlsStatus === 'active' &&
              !primaryDomainRoute?.httpOnly
                ? 'url-https'
                : 'url-http-primary'
            "
            >{{ serviceUrl }}</a
          >
          <template
            v-if="
              primaryDomainRoute?.tlsStatus === 'active' &&
              !primaryDomainRoute?.httpOnly
            "
          >
            <span class="url-sep">·</span>
            <a
              :href="serviceUrl.replace('https://', 'http://')"
              target="_blank"
              rel="noopener"
              class="url-http"
              >http</a
            >
          </template>
          <template
            v-if="
              primaryDomainRoute?.domain &&
              !primaryDomainRoute?.httpOnly &&
              primaryDomainRoute.tlsStatus !== 'active'
            "
          >
            <span class="url-sep">·</span>
            <span
              :class="
                primaryDomainRoute.tlsStatus === 'error'
                  ? 'tls-badge tls-error'
                  : 'tls-badge tls-pending'
              "
              >{{
                primaryDomainRoute.tlsStatus === "error"
                  ? "TLS error"
                  : "TLS pending"
              }}</span
            >
            <button
              class="btn-ghost-sm tls-retry-btn"
              :disabled="tlsRetrying"
              @click="retryRouteTls(primaryDomainRoute!.id)"
            >
              {{ tlsRetrying ? "Checking..." : "Retry" }}
            </button>
          </template>
        </div>
        <div v-else-if="fallbackUrl" class="hero-url hint">
          No domain route yet - fallback: <code>{{ fallbackUrl }}</code>
        </div>
        <div v-else class="hero-url hint">No route assigned yet.</div>

        <div v-if="deployError" class="alert error" style="margin-top: 0.75rem">
          {{ deployError }}
        </div>
        <div
          v-if="service.status === 'failed'"
          class="deploy-notice deploy-notice-failed"
        >
          Last deploy failed — check build logs below.
        </div>
        <div
          v-else-if="
            service.status === 'building' || service.status === 'queued'
          "
          class="deploy-notice deploy-notice-building"
        >
          Deploy in progress — site will update once it finishes.
        </div>
        <div
          v-if="!service.active"
          class="deploy-notice deploy-notice-inactive"
        >
          This service was deactivated. Routes are not served and the container
          is stopped. Activate it from the danger zone below to resume.
        </div>
      </div>

      <!-- ── Info rows ─────────────────────────────────────────────── -->
      <div class="info-rows">
        <div class="info-row">
          <span class="info-label">Repo</span>
          <span class="info-value mono"
            >{{ service.repo.repoOwner }}/{{ service.repo.repoName }}:{{
              service.branch
            }}</span
          >
        </div>
        <div class="info-row">
          <span class="info-label">Type</span>
          <span class="info-value">{{ deployTypeLabel }}</span>
        </div>
        <div v-if="service.deployMode === 'server'" class="info-row">
          <span class="info-label">Port</span>
          <span class="info-value mono">{{ service.containerPort }}</span>
        </div>
        <div
          v-if="service.deployMode === 'static' && service.buildImage"
          class="info-row"
        >
          <span class="info-label">Build image</span>
          <span class="info-value mono">{{ service.buildImage }}</span>
        </div>
        <div class="info-row">
          <span class="info-label">GitHub</span>
          <span class="info-value">{{
            service.repo.githubMode === "app" ? "App" : "Webhook"
          }}</span>
        </div>
      </div>

      <!-- ── Environment Variables ──────────────────────────────────── -->
      <div class="section">
        <h2>Environment Variables</h2>
        <p class="section-hint">
          One per line, <code class="inline-code">KEY=value</code> format.
          <code class="inline-code">PORT</code> is set automatically. Each
          container gets a persistent <code class="inline-code">/data</code>
          directory (available in code as
          <code class="inline-code">DATA_DIR=/data</code>).
        </p>
        <button
          type="button"
          class="btn-ghost-sm env-toggle"
          @click="envEditorExpanded = !envEditorExpanded"
        >
          {{ envEditorExpanded ? "Hide env vars" : "Show env vars" }}
        </button>
        <p v-if="!envEditorExpanded" class="env-collapsed-note">
          Hidden by default because values may contain secrets.
        </p>
        <template v-else>
          <textarea
            v-model="envVarsText"
            class="env-textarea"
            rows="6"
            placeholder="DATABASE_URL=file:/data/app.db&#10;MY_SECRET=changeme"
            spellcheck="false"
          ></textarea>
          <div class="env-actions">
            <button
              class="btn-primary"
              :disabled="envSaving || envVarsText === (service.envVars ?? '')"
              @click="saveEnvVars"
            >
              {{ envSaving ? "Saving..." : "Save" }}
            </button>
            <span v-if="envSaved" class="env-saved">Saved</span>
            <span v-if="envError" class="env-error">{{ envError }}</span>
          </div>
        </template>
      </div>

      <!-- ── Routes ────────────────────────────────────────────────── -->
      <div class="section">
        <h2>Routes</h2>
        <p class="section-hint">
          Each route maps a domain (or path prefix) to this service.
        </p>
        <button
          class="btn-primary"
          type="button"
          :disabled="routeSaving || domains.length === 0"
          @click="addRouteModalOpen = true"
        >
          + Add route
        </button>
        <div v-if="service.routes.length === 0" class="empty-msg">
          No domain routes yet.
        </div>
        <div v-else class="route-list">
          <div v-for="r in service.routes" :key="r.id" class="route-row">
            <div class="route-url-wrap">
              <a
                v-if="routeHasLink(r)"
                :href="routeLabel(r)"
                target="_blank"
                rel="noopener"
                class="route-url mono route-url-link"
                >{{ routeLabel(r) }}</a
              >
              <span v-else class="route-url mono">{{ routeLabel(r) }}</span>
            </div>
            <div class="route-meta">
              <span v-if="r.pathPrefix" class="route-badge">path</span>
              <template v-if="r.httpOnly">
                <span class="route-badge">http only</span>
              </template>
              <template v-else-if="r.domain && r.tlsStatus === 'active'">
                <span class="route-badge route-badge-tls">https</span>
              </template>
              <template
                v-else-if="
                  r.domain &&
                  !r.httpOnly &&
                  (r.tlsStatus === 'unchecked' || r.tlsStatus === 'error')
                "
              >
                <span
                  :class="
                    r.tlsStatus === 'error'
                      ? 'route-badge route-badge-err'
                      : 'route-badge route-badge-warn'
                  "
                  >{{
                    r.tlsStatus === "error" ? "HTTPS error" : "HTTPS pending"
                  }}</span
                >
                <button
                  class="btn-ghost-sm tls-retry-btn"
                  :disabled="tlsRetrying"
                  @click="retryRouteTls(r.id)"
                >
                  Retry
                </button>
              </template>
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
      </div>

      <!-- ── GitHub Webhook setup ───────────────────────────────────── -->
      <div v-if="service.repo.githubMode === 'webhook'" class="webhook-card">
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
        <div v-if="service.deployments.length === 0" class="empty-msg">
          No deployments yet.
        </div>
        <div v-else class="deploy-list">
          <div
            v-for="d in service.deployments"
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
      <div v-if="service.deployMode === 'server'" class="section">
        <h2>Docker logs</h2>
        <p class="section-hint">
          View live container output in the
          <RouterLink
            :to="`/logs/sitey-service-${service.id}`"
            class="logs-link"
            >Logs tab</RouterLink
          >.
        </p>
      </div>

      <!-- ── Danger zone ───────────────────────────────────────────── -->
      <div class="section">
        <h2>Service Settings</h2>
        <p class="section-hint">
          Change deploy/build mode and related runtime/build fields.
        </p>
        <form class="settings-form" @submit.prevent="saveServiceSettings">
          <div class="text-option-group">
            <div class="text-option-label">Deploy type</div>
            <div class="text-option-row">
              <button
                type="button"
                :class="{ active: editDeployType === 'static' }"
                @click="editDeployType = 'static'"
              >
                Static site
              </button>
              <button
                type="button"
                :class="{ active: editDeployType === 'server' }"
                @click="editDeployType = 'server'"
              >
                Server app
              </button>
              <button
                type="button"
                :class="{ active: editDeployType === 'dockerfile' }"
                @click="editDeployType = 'dockerfile'"
              >
                Dockerfile
              </button>
            </div>
            <div class="text-option-help">
              <span v-if="editDeployType === 'static'"
                >Build your site and serve the output as static files via
                Caddy.</span
              >
              <span v-else-if="editDeployType === 'server'"
                >Sitey generates a Dockerfile from your run command and runs it
                in a container.</span
              >
              <span v-else
                >Use your own <code>Dockerfile</code> from the repository.</span
              >
            </div>
          </div>

          <label v-if="editDeployType === 'static'">
            Build command <span class="hint">(optional)</span>
            <textarea
              v-model="editBuildCommand"
              placeholder="npm run build"
              rows="3"
            />
          </label>
          <label v-if="editDeployType === 'static'">
            Output directory <span class="hint">(relative to repo root)</span>
            <input v-model="editOutputDir" type="text" placeholder="dist" />
          </label>
          <label v-if="editDeployType === 'static'">
            Build image
            <DockerImageHint />
            <input
              v-model="editBuildImage"
              type="text"
              placeholder="Leave empty to use Node.js 24"
            />
          </label>

          <label v-if="editDeployType === 'server'">
            Build command <span class="hint">(optional)</span>
            <textarea
              v-model="editBuildCommand"
              placeholder="npm run build"
              rows="3"
            />
          </label>
          <label v-if="editDeployType === 'server'">
            Start command <span class="hint">(e.g. node server.js)</span>
            <input
              v-model="editServerRunCommand"
              type="text"
              required
              placeholder="node server.js"
            />
          </label>
          <label v-if="editDeployType === 'server'">
            Container port
            <input
              v-model.number="editContainerPort"
              type="number"
              min="1"
              max="65535"
              required
            />
          </label>

          <label v-if="editDeployType === 'dockerfile'">
            Dockerfile path <span class="hint">(relative to repo root)</span>
            <input
              v-model="editDockerfilePath"
              type="text"
              placeholder="Dockerfile"
            />
          </label>
          <label v-if="editDeployType === 'dockerfile'">
            Container port
            <input
              v-model.number="editContainerPort"
              type="number"
              min="1"
              max="65535"
              required
            />
          </label>

          <button
            class="btn-primary"
            type="submit"
            :disabled="!settingsDirty || settingsSaving"
          >
            {{ settingsSaving ? "Saving..." : "Save changes" }}
          </button>
          <div v-if="settingsSaved" class="settings-saved">Saved</div>
          <div v-if="settingsError" class="settings-error">
            {{ settingsError }}
          </div>
        </form>
      </div>

      <div class="danger-zone">
        <h2>Danger zone</h2>

        <div class="danger-item">
          <div class="danger-item-text">
            <template v-if="service.active">
              <strong>Deactivate service</strong>
              <p class="danger-desc">
                Stops the container and removes Caddy routes so the service no
                longer serves traffic. All data, configuration, and deployment
                history are preserved. You can reactivate at any time.
              </p>
            </template>
            <template v-else>
              <strong>Activate service</strong>
              <p class="danger-desc">
                Re-enables the service. You will need to trigger a new deploy to
                start the container and resume serving traffic.
              </p>
            </template>
          </div>
          <button
            v-if="service.active"
            class="btn-danger"
            :disabled="toggling"
            @click="deactivateService"
          >
            {{ toggling ? "Deactivating..." : "Deactivate service" }}
          </button>
          <button
            v-else
            class="btn-activate"
            :disabled="toggling"
            @click="activateService"
          >
            {{ toggling ? "Activating..." : "Activate service" }}
          </button>
        </div>

        <div class="danger-item">
          <div class="danger-item-text">
            <strong>Delete service</strong>
            <p class="danger-desc">
              Stops the container and removes all files. This cannot be undone.
            </p>
          </div>
          <button
            class="btn-danger"
            :disabled="deleting"
            @click="deleteService"
          >
            {{ deleting ? "Deleting..." : "Delete service" }}
          </button>
        </div>
      </div>
    </template>

    <!-- TLS troubleshooting modal -->
    <div v-if="tlsModal" class="modal-overlay" @click.self="tlsModal = false">
      <div class="modal">
        <h3>HTTPS certificate not ready</h3>
        <p>
          HTTPS isn't working for <code>{{ tlsModalHostname }}</code> yet. Caddy
          is still trying to obtain a Let's Encrypt certificate.
        </p>
        <p>Common causes:</p>
        <ul>
          <li>
            <strong>DNS not pointing here</strong> — the domain must resolve to
            this server's public IP before Let's Encrypt can verify it.
          </li>
          <li>
            <strong>Ports 80/443 blocked</strong> — Let's Encrypt needs to reach
            port 80 for the HTTP-01 challenge.
          </li>
          <li>
            <strong>Rate limits</strong> — Let's Encrypt has per-domain rate
            limits. If you've been testing a lot, wait an hour and retry.
          </li>
          <li>
            <strong>Caddy error</strong> — check the Caddy logs for details:<br />
            <code>docker compose logs caddy --tail 50</code>
          </li>
        </ul>
        <p>
          The site is still reachable over plain HTTP while HTTPS is pending.
        </p>
        <div class="modal-actions">
          <button class="btn-primary" @click="tlsModal = false">OK</button>
        </div>
      </div>
    </div>

    <AddRouteModal
      v-model="addRouteModalOpen"
      :domains="domains"
      :saving="routeSaving"
      :error="routeError"
      @submit="addRoute"
    />
  </Layout>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from "vue";
import { useRoute, useRouter, RouterLink } from "vue-router";
import Layout from "../components/Layout.vue";
import AddRouteModal from "../components/AddRouteModal.vue";
import DockerImageHint from "../components/DockerImageHint.vue";
import { trpc } from "../trpc";

type Service = Awaited<ReturnType<typeof trpc.services.get.query>>;
type ServiceRoute = Service["routes"][number];
type WebhookInfo = Awaited<
  ReturnType<typeof trpc.services.getWebhookInfo.query>
>;
type Domain = Awaited<ReturnType<typeof trpc.domains.list.query>>[number];
const VIRTUAL_LOOPBACK_DOMAIN_ID = -127001;

const route = useRoute();
const router = useRouter();
const serviceId = Number(route.params.id);

const service = ref<Service | null>(null);
const domains = ref<Pick<Domain, "id" | "hostname">[]>([]);
const loading = ref(true);
const error = ref("");
const deploying = ref(false);
const deployError = ref("");
const deleting = ref(false);
const toggling = ref(false);
const routeSaving = ref(false);
const routeError = ref("");
const addRouteModalOpen = ref(false);
const webhookInfo = ref<WebhookInfo | null>(null);
const webhookError = ref("");
const webhookDomainId = ref<number | null>(null);
const selectedDeployId = ref<string | null>(null);
const logLines = ref<string[]>([]);
const logBox = ref<HTMLElement | null>(null);
const logsLoading = ref(false);
const envVarsText = ref("");
const envEditorExpanded = ref(false);
const envSaving = ref(false);
const envSaved = ref(false);
const envError = ref("");
const titleEditing = ref(false);
const titleDraft = ref("");
const titleSaving = ref(false);
const titleError = ref("");
const editDeployType = ref<"static" | "server" | "dockerfile">("server");
const editBuildCommand = ref("");
const editOutputDir = ref("");
const editBuildImage = ref("");
const editServerRunCommand = ref("");
const editDockerfilePath = ref("");
const editContainerPort = ref(3000);
const settingsSaving = ref(false);
const settingsSaved = ref(false);
const settingsError = ref("");
const tlsRetrying = ref(false);
const tlsModal = ref(false);
const tlsModalHostname = ref("");
const LOG_POLL_MS = 3000;
let logPollTimer: ReturnType<typeof setInterval> | null = null;

const primaryDomainRoute = computed(
  () => service.value?.routes.find((r) => !!r.domain) ?? null,
);

function routeHostname(r: ServiceRoute): string {
  if (!r.domain?.hostname) return "";
  if (!r.domain.hostname.startsWith("*.")) return r.domain.hostname;
  return r.subdomain
    ? `${r.subdomain}.${r.domain.hostname.slice(2)}`
    : r.domain.hostname;
}

const serviceUrl = computed(() => {
  const r = primaryDomainRoute.value;
  if (!r?.domain) return "";
  const scheme = !r.httpOnly && r.tlsStatus === "active" ? "https" : "http";
  return `${scheme}://${routeHostname(r)}${r.pathPrefix || ""}`;
});

const fallbackUrl = computed(() => {
  if (!service.value?.hostPort) return "";
  return `http://<server-ip>:${service.value.hostPort}`;
});

const deployTypeLabel = computed(() => {
  if (!service.value) return "";
  if (service.value.deployMode === "static") return "Static site";
  if (service.value.buildMode === "dockerfile") {
    const p = service.value.dockerfilePath || "Dockerfile";
    return p === "Dockerfile" ? "Dockerfile" : `Dockerfile (${p})`;
  }
  return "Server app";
});

const titleDirty = computed(() => {
  if (!service.value) return false;
  return titleDraft.value.trim() !== service.value.name;
});

const settingsDirty = computed(() => {
  if (!service.value) return false;
  const modeDirty =
    (editDeployType.value === "static" &&
      (service.value.deployMode !== "static" ||
        service.value.buildMode !== "auto")) ||
    (editDeployType.value === "server" &&
      (service.value.deployMode !== "server" ||
        service.value.buildMode !== "auto")) ||
    (editDeployType.value === "dockerfile" &&
      (service.value.deployMode !== "server" ||
        service.value.buildMode !== "dockerfile"));

  return (
    modeDirty ||
    editBuildCommand.value.trim() !== (service.value.buildCommand ?? "") ||
    editOutputDir.value.trim() !== (service.value.outputDir ?? "") ||
    editBuildImage.value.trim() !== (service.value.buildImage ?? "") ||
    editServerRunCommand.value.trim() !==
      (service.value.serverRunCommand ?? "") ||
    editDockerfilePath.value.trim() !== (service.value.dockerfilePath ?? "") ||
    Number(editContainerPort.value) !== Number(service.value.containerPort)
  );
});

const selectedDeployment = computed(
  () =>
    service.value?.deployments.find((d) => d.id === selectedDeployId.value) ??
    null,
);

const shouldAutoRefreshLogs = computed(() => {
  if (!selectedDeployId.value) return false;
  const status = selectedDeployment.value?.status ?? service.value?.status;
  return status === "building" || status === "queued";
});

function normalizePathPrefix(input: string): string {
  const raw = input.trim();
  if (!raw || raw === "/") return "";
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function routeLabel(r: ServiceRoute): string {
  const pathPrefix = r.pathPrefix || "";
  const hostname = routeHostname(r);
  if (hostname) {
    const scheme = !r.httpOnly && r.tlsStatus === "active" ? "https" : "http";
    return `${scheme}://${hostname}${pathPrefix}`;
  }
  return pathPrefix ? `<server>${pathPrefix}` : "<server>";
}

function routeHasLink(r: ServiceRoute): boolean {
  return !!r.domain?.hostname;
}

function applyServiceToEditors(svc: Service) {
  titleDraft.value = svc.name;
  editBuildCommand.value = svc.buildCommand ?? "";
  editOutputDir.value = svc.outputDir ?? "";
  editBuildImage.value = svc.buildImage ?? "";
  editServerRunCommand.value = svc.serverRunCommand ?? "";
  editDockerfilePath.value = svc.dockerfilePath ?? "";
  editContainerPort.value = svc.containerPort;
  editDeployType.value =
    svc.deployMode === "static"
      ? "static"
      : svc.buildMode === "dockerfile"
        ? "dockerfile"
        : "server";
}

async function fetchService() {
  loading.value = true;
  error.value = "";
  try {
    const [svc, domainList] = await Promise.all([
      trpc.services.get.query({ id: serviceId }),
      trpc.domains.list.query(),
    ]);
    service.value = svc;
    applyServiceToEditors(svc);
    envVarsText.value = svc.envVars ?? "";
    domains.value = domainList.map((d) => ({ id: d.id, hostname: d.hostname }));
    if (!domains.value.some((d) => d.hostname === "127.0.0.1")) {
      domains.value.push({
        id: VIRTUAL_LOOPBACK_DOMAIN_ID,
        hostname: "127.0.0.1",
      });
    }
    if (service.value.repo.githubMode === "webhook") {
      await refetchWebhookInfo();
    } else {
      webhookInfo.value = null;
      webhookDomainId.value = null;
    }

    if (service.value.deployments[0]) {
      selectedDeployId.value = service.value.deployments[0].id;
      await fetchLogs();
    } else {
      selectedDeployId.value = null;
      logLines.value = [];
    }
  } catch (e: unknown) {
    error.value =
      (e as { message?: string })?.message ?? "Failed to load service";
  } finally {
    loading.value = false;
  }
}

async function saveServiceSettings() {
  if (!service.value) return;
  settingsSaving.value = true;
  settingsError.value = "";
  settingsSaved.value = false;
  try {
    const deployMode = editDeployType.value === "static" ? "static" : "server";
    const buildMode =
      editDeployType.value === "dockerfile" ? "dockerfile" : "auto";
    const updated = await trpc.services.update.mutate({
      id: serviceId,
      deployMode,
      buildMode,
      buildCommand: editBuildCommand.value.trim(),
      outputDir: editOutputDir.value.trim(),
      buildImage: editBuildImage.value.trim(),
      serverRunCommand: editServerRunCommand.value.trim(),
      dockerfilePath: editDockerfilePath.value.trim(),
      containerPort: Number(editContainerPort.value),
    });
    service.value = {
      ...service.value,
      ...updated,
    };
    applyServiceToEditors(service.value);
    settingsSaved.value = true;
    setTimeout(() => (settingsSaved.value = false), 2000);
  } catch (e: unknown) {
    settingsError.value =
      (e as { message?: string })?.message ?? "Failed to save settings";
  } finally {
    settingsSaving.value = false;
  }
}

function startTitleEdit() {
  if (!service.value) return;
  titleDraft.value = service.value.name;
  titleError.value = "";
  titleEditing.value = true;
}

function cancelTitleEdit() {
  if (service.value) titleDraft.value = service.value.name;
  titleError.value = "";
  titleEditing.value = false;
}

async function saveTitleEdit() {
  if (!service.value) return;
  titleSaving.value = true;
  titleError.value = "";
  try {
    const updated = await trpc.services.update.mutate({
      id: serviceId,
      name: titleDraft.value.trim(),
    });
    service.value = {
      ...service.value,
      name: updated.name,
    };
    titleDraft.value = updated.name;
    titleEditing.value = false;
  } catch (e: unknown) {
    titleError.value =
      (e as { message?: string })?.message ?? "Failed to save name";
  } finally {
    titleSaving.value = false;
  }
}

async function saveEnvVars() {
  envSaving.value = true;
  envError.value = "";
  envSaved.value = false;
  try {
    await trpc.services.update.mutate({
      id: serviceId,
      envVars: envVarsText.value,
    });
    if (service.value) service.value.envVars = envVarsText.value;
    envSaved.value = true;
    setTimeout(() => (envSaved.value = false), 2000);
  } catch (e: unknown) {
    envError.value =
      (e as { message?: string })?.message ?? "Failed to save env vars";
  } finally {
    envSaving.value = false;
  }
}

async function addRoute(input: {
  domainId: number;
  domainHostname: string;
  pathPrefix: string;
  subdomain: string;
  httpOnly: boolean;
}) {
  routeSaving.value = true;
  routeError.value = "";
  try {
    let domainId = input.domainId;
    if (domainId <= 0) {
      const existing = domains.value.find(
        (d) => d.hostname === input.domainHostname && d.id > 0,
      );
      if (existing) {
        domainId = existing.id;
      } else {
        const created = await trpc.domains.create.mutate({
          hostname: input.domainHostname,
        });
        domainId = created.id;
      }
    }

    await trpc.services.addRoute.mutate({
      serviceId,
      domainId,
      pathPrefix: normalizePathPrefix(input.pathPrefix),
      subdomain: input.subdomain.trim().toLowerCase(),
      httpOnly: input.httpOnly,
    });
    addRouteModalOpen.value = false;
    await fetchService();
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
    await trpc.services.removeRoute.mutate({ routeId });
    await fetchService();
  } catch (e: unknown) {
    routeError.value =
      (e as { message?: string })?.message ?? "Failed to remove route";
  } finally {
    routeSaving.value = false;
  }
}

async function retryRouteTls(routeId: string) {
  tlsRetrying.value = true;
  try {
    const res = await trpc.services.retryRouteTls.mutate({ routeId });
    // Update the route's tlsStatus in-place so the UI reacts immediately.
    const route = service.value?.routes.find((r) => r.id === routeId);
    if (route) route.tlsStatus = res.tlsStatus;
    // If still not active, show the troubleshooting modal.
    if (res.tlsStatus !== "active") {
      tlsModalHostname.value = route ? routeHostname(route) : "";
      tlsModal.value = true;
    }
  } catch (e: unknown) {
    const route = service.value?.routes.find((r) => r.id === routeId);
    tlsModalHostname.value = route ? routeHostname(route) : "";
    tlsModal.value = true;
  } finally {
    tlsRetrying.value = false;
  }
}

async function triggerDeploy() {
  deploying.value = true;
  deployError.value = "";
  try {
    const res = await trpc.deploy.trigger.mutate({
      serviceId,
      triggeredBy: "manual",
    });
    selectedDeployId.value = res.deploymentId;
    await fetchService();
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
    const info = await trpc.services.getWebhookInfo.query({
      id: serviceId,
      ...(webhookDomainId.value ? { domainId: webhookDomainId.value } : {}),
    });
    webhookInfo.value = info;
  } catch (e: unknown) {
    webhookInfo.value = null;
    webhookError.value =
      (e as { message?: string })?.message ?? "Could not resolve webhook URL.";
  }
}

async function deleteService() {
  if (
    !confirm(
      `Delete service "${service.value?.name}"? This will stop the container and remove all files.`,
    )
  )
    return;
  deleting.value = true;
  try {
    await trpc.services.delete.mutate({ id: serviceId });
    router.push("/");
  } catch (e: unknown) {
    alert((e as { message?: string })?.message ?? "Failed to delete service");
    deleting.value = false;
  }
}

async function deactivateService() {
  if (
    !confirm(
      `Deactivate "${service.value?.name}"? The container will be stopped and routes will no longer serve traffic.`,
    )
  )
    return;
  toggling.value = true;
  try {
    await trpc.services.deactivate.mutate({ id: serviceId });
    await fetchService();
  } catch (e: unknown) {
    alert(
      (e as { message?: string })?.message ?? "Failed to deactivate service",
    );
  } finally {
    toggling.value = false;
  }
}

async function activateService() {
  toggling.value = true;
  try {
    await trpc.services.activate.mutate({ id: serviceId });
    await fetchService();
  } catch (e: unknown) {
    alert((e as { message?: string })?.message ?? "Failed to activate service");
  } finally {
    toggling.value = false;
  }
}

async function rotateSecret() {
  if (!confirm("Rotate webhook secret? You will need to update GitHub."))
    return;
  const res = await trpc.services.rotateWebhookSecret.mutate({ id: serviceId });
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
  await fetchService();
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
watch(addRouteModalOpen, (open) => {
  if (open) routeError.value = "";
});
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

.title-edit-btn {
  --btn-primary-padding: 0.3rem 0.6rem;
}

.title-edit-form {
  margin-bottom: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  max-width: 680px;
}

.title-edit-actions {
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

.url-http-primary {
  color: var(--brand);
  text-decoration: none;
  font-weight: 500;
}

.url-http-primary:hover {
  text-decoration: underline;
}

.tls-badge {
  font-size: var(--font-tiny);
  padding: 0.15rem 0.45rem;
  border-radius: 4px;
  font-weight: 500;
}

.tls-pending {
  background: var(--status-warn-bg);
  color: var(--status-warn-text);
}

.tls-error {
  background: var(--status-err-bg);
  color: var(--status-err-text);
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

.deploy-notice-inactive {
  background: var(--status-warn-bg, #3d2e00);
  color: var(--status-warn-text, #f5a623);
}

/* ── Info grid ───────────────────────────────────────────────── */
.info-rows {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  margin-bottom: 2rem;
}

.info-row {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  font-size: var(--font-small);
}

.info-label {
  font-size: var(--font-tiny);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  white-space: nowrap;
  min-width: 6rem;
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

/* ── Env vars ──────────────────────────────────────────────── */
.env-textarea {
  width: 100%;
  background: var(--bg-code);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  padding: 0.75rem 1rem;
  font-family: monospace;
  font-size: var(--font-tiny);
  line-height: 1.6;
  resize: vertical;
  outline: none;
  transition: border-color 0.15s;
  color: inherit;
}

.env-textarea:focus {
  border-color: var(--brand);
}

.env-toggle {
  width: fit-content;
}

.env-collapsed-note {
  font-size: var(--font-tiny);
  margin: 0.5rem 0 0;
  color: var(--text-muted);
}

.env-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-top: 0.5rem;
}

.env-saved {
  font-size: var(--font-tiny);
  color: var(--status-ok-text);
}

.env-error {
  font-size: var(--font-tiny);
  color: var(--status-err-text);
}

.settings-form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  max-width: 680px;
}

.settings-saved {
  font-size: var(--font-tiny);
  color: var(--status-ok-text);
}

.settings-error {
  font-size: var(--font-tiny);
  color: var(--status-err-text);
}

.inline-code {
  background: var(--bg-elevated);
  padding: 0.1rem 0.35rem;
  border-radius: 3px;
  font-size: 0.9em;
  display: inline;
  flex: initial;
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

.route-badge-warn {
  background: var(--status-warn-bg);
  color: var(--status-warn-text);
  border-color: transparent;
}

.route-badge-err {
  background: var(--status-err-bg);
  color: var(--status-err-text);
  border-color: transparent;
}

/* ── Add route box ──────────────────────────────────────────── */
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

.status-inactive {
  background: var(--status-warn-bg, #3d2e00);
  color: var(--status-warn-text, #f5a623);
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

.btn-danger {
  background: var(--status-err-bg);
  color: var(--status-err-text);
  border: 1px solid var(--status-err-border);
  border-radius: 6px;
  padding: 0.6rem 1.25rem;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
  white-space: nowrap;
  flex-shrink: 0;
}

.btn-danger:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-danger:hover:not(:disabled) {
  background: #4a1a1a;
  border-color: var(--status-err-border);
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

.danger-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1.5rem;
  padding: 1rem 0;
  border-bottom: 1px solid var(--border-subtle);
}

.danger-item:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.danger-item-text {
  flex: 1;
}

.danger-item-text strong {
  font-size: var(--font-small, 0.95rem);
}

.danger-desc {
  font-size: var(--font-tiny);
  margin-top: 0.25rem;
  margin-bottom: 0;
}

.btn-activate {
  background: var(--status-ok-bg);
  color: var(--status-ok-text);
  border: 1px solid var(--status-ok-text);
  border-radius: 6px;
  padding: 0.6rem 1.25rem;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
  white-space: nowrap;
  flex-shrink: 0;
}

.btn-activate:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-activate:hover:not(:disabled) {
  opacity: 0.85;
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
