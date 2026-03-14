<template>
  <Layout>
    <div class="page-header">
      <h1>Dashboard</h1>
    </div>

    <div v-if="loading" class="state-msg">Loading...</div>
    <div v-else-if="error" class="alert error">{{ error }}</div>

    <template v-else>
      <div class="onboarding" :class="{ complete: allDone }">
        <div class="onboarding-header" @click="allDone ? (expanded = !expanded) : undefined">
          <div class="onboarding-title-row">
            <span v-if="allDone" class="onboarding-check">✓</span>
            <h2 class="onboarding-title">{{ allDone ? 'Setup complete' : 'Getting started' }}</h2>
          </div>
          <button v-if="allDone" class="onboarding-toggle" type="button">
            {{ expanded ? 'Hide' : 'Show steps' }}
          </button>
        </div>

        <!-- Sitey URL banner when setup is done -->
        <div v-if="allDone && siteyUrl" class="sitey-url-banner">
          Your Sitey is live at
          <a :href="siteyUrl" target="_blank" rel="noopener">{{ siteyUrl }}</a>
        </div>

        <div v-if="!allDone || expanded" class="onboarding-steps">

          <!-- Step 1: Domain -->
          <div class="step" :class="{ done: hasDomain }">
            <div class="step-check">{{ hasDomain ? '✓' : '1' }}</div>
            <div class="step-body">
              <h3 class="step-heading">Set up a wildcard domain</h3>
              <p class="step-desc">
                Add a wildcard DNS A record (<code>*.example.com</code> or <code>*.s.example.com</code>)
                pointing to this server's public IP<template v-if="serverIp">
                  (detected: <code>{{ serverIp }}</code> but it might be wrong)</template>.
                Sitey will automatically issue HTTPS certificates for all your projects.
              </p>
              <div class="inline-action">
                <template v-if="!hasDomain">
                  <button class="step-inline-btn" @click="showAddDomain = true">Add domain now -></button>
                </template>
                <template v-else>
                  <RouterLink to="/domains" class="step-link">Manage domains -></RouterLink>
                </template>
              </div>
            </div>
          </div>

          <!-- Step 2: Switch to HTTPS URL -->
          <div class="step" :class="{ done: isHttps }">
            <div class="step-check">{{ isHttps ? '✓' : '2' }}</div>
            <div class="step-body">
              <h3 class="step-heading">Open Sitey at its HTTPS address</h3>
              <div v-if="isHttp" class="step-warning">
                You are currently using plain HTTP. That's ok to start, but not safe to keep forever. GitHub webhooks
                and OAuth require HTTPS.
                Set up your domain first, then open Sitey at your new HTTPS URL.
              </div>
              <p class="step-desc">
                GitHub requires HTTPS for OAuth and webhooks. Once your domain is set up and the
                certificate is issued, continue setup from your HTTPS Sitey URL.
              </p>
              <div class="inline-action">
                <template v-if="siteyUrl">
                  <a :href="siteyUrl" class="step-inline-btn" target="_blank" rel="noopener">
                    Open {{ siteyUrl }} ->
                  </a>
                </template>
                <template v-else>
                  <span class="step-hint">Complete step 1 first - Sitey will generate your HTTPS URL
                    automatically.</span>
                </template>
              </div>
            </div>
          </div>

          <!-- Step 3: GitHub App -->
          <div class="step" :class="{ done: hasGitHubReady }">
            <div class="step-check">{{ hasGitHubReady ? '✓' : '3' }}</div>
            <div class="step-body">
              <h3 class="step-heading">Connect and install GitHub App</h3>
              <div v-if="!hasGitHubAppConfig" class="step-desc">
                Connect GitHub so Sitey can clone your repos and auto-deploy on push.
                Click <strong class="secondary">Create GitHub App automatically</strong> in Integrations and Sitey
                pre-fills everything.
              </div>
              <div v-else-if="!hasGitHubInstall" class="step-desc">
                GitHub App is created, but it still needs to be installed on at least one personal account or
                organization before repository autocomplete will work.
              </div>
              <div v-else class="step-desc">
                GitHub App is connected and installed. Repository autocomplete is ready.
              </div>
              <div class="inline-action">
                <RouterLink to="/integrations" class="step-inline-btn">
                  {{ hasGitHubReady ? 'Manage integrations ->' : hasGitHubAppConfig ? 'Finish GitHub install ->' : 'Connect GitHub ->' }}
                </RouterLink>
              </div>
            </div>
          </div>

          <!-- Step 4: Project -->
          <div class="step" :class="{ done: hasProject }">
            <div class="step-check">{{ hasProject ? '✓' : '4' }}</div>
            <div class="step-body">
              <h3 class="step-heading">Add your first project</h3>
              <div class="step-desc">
                Connect a GitHub repository to a domain and launch your first live deployment.
              </div>
              <div class="inline-action">
                <template v-if="!hasProject">
                  <button class="step-inline-btn" @click="showAddProject = true">Add project now -></button>
                </template>
                <template v-else>
                  <RouterLink to="/projects" class="step-link">View projects -></RouterLink>
                </template>
              </div>
            </div>
          </div>

        </div>
      </div>
    </template>

    <AddDomainModal v-model="showAddDomain" @created="fetchAll" />
    <AddProjectModal v-model="showAddProject" title="New project" :domains="domains" @created="onProjectCreated" />
  </Layout>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import Layout from '../components/Layout.vue'
import AddProjectModal from '../components/AddProjectModal.vue'
import AddDomainModal from '../components/AddDomainModal.vue'
import { trpc } from '../trpc'

type Domain = Awaited<ReturnType<typeof trpc.domains.list.query>>[number]

const router = useRouter()
const loading = ref(true)
const error = ref('')
const hasDomain = ref(false)
const hasGitHubAppConfig = ref(false)
const hasGitHubInstall = ref(false)
const hasProject = ref(false)
const expanded = ref(false)
const siteyUrl = ref('')
const domains = ref<Pick<Domain, 'id' | 'hostname'>[]>([])

const serverIp = ref('')
const isHttp = window.location.protocol === 'http:'
const showAddDomain = ref(false)
const showAddProject = ref(false)

const isHttps = window.location.protocol === 'https:'
const hasGitHubReady = computed(
  () => hasGitHubAppConfig.value && hasGitHubInstall.value,
)
const allDone = computed(() => hasDomain.value && isHttps && hasGitHubReady.value && hasProject.value)

async function fetchAll() {
  loading.value = true
  error.value = ''
  try {
    const [projectList, domainList, appConfig, repoInfo, siteUrlInfo, ipInfo] = await Promise.all([
      trpc.projects.list.query(),
      trpc.domains.list.query(),
      trpc.github.getAppConfig.query(),
      trpc.github.listAppRepos.query().catch(() => null),
      trpc.system.getPublicSiteUrl.query().catch(() => null),
      trpc.system.getServerIp.query().catch(() => null),
    ])
    hasDomain.value = domainList.length > 0
    hasGitHubAppConfig.value = appConfig.configured
    hasGitHubInstall.value = !!(
      repoInfo &&
      repoInfo.configured &&
      repoInfo.installations.length > 0
    )
    hasProject.value = projectList.filter(p => !p.protected).length > 0
    domains.value = domainList.map(d => ({ id: d.id, hostname: d.hostname }))
    siteyUrl.value = siteUrlInfo?.effectiveUrl ?? ''
    serverIp.value = ipInfo?.ip ?? ''
  } catch (e: unknown) {
    error.value = (e as { message?: string })?.message ?? 'Failed to load'
  } finally {
    loading.value = false
  }
}

async function onProjectCreated(projectId: number) {
  await router.push(`/projects/${projectId}`)
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
  font-weight: 600;
}

.onboarding {
  background: var(--bg-card);
  border: 1px solid var(--border-default);
  border-radius: 12px;
  padding: 1.5rem;
  margin-bottom: 2rem;
  transition: border-color 0.2s;
}

.onboarding.complete {
  border-color: var(--brand);
  background: linear-gradient(135deg, var(--bg-card) 0%, var(--brand-active-bg) 100%);
}

.onboarding-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0;
}

.onboarding.complete .onboarding-header {
  cursor: pointer;
}

.onboarding-title-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.onboarding-check {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--status-ok-bg);
  border: 2px solid var(--status-ok-border);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--font-tiny);
  font-weight: 700;
  color: var(--status-ok-text);
  flex-shrink: 0;
}

.onboarding-title {
  font-size: var(--font-medium);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.onboarding.complete .onboarding-title {
  color: var(--brand-active-text);
}

.onboarding-toggle {
  background: none;
  border: 1px solid var(--border-default);
  border-radius: 5px;
  font-size: var(--font-tiny);
  padding: 0.2rem 0.6rem;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}

.onboarding-toggle:hover {
  border-color: var(--brand);
  color: var(--brand-active-text);
}

/* Sitey URL banner */
.sitey-url-banner {
  margin-top: 0.75rem;
}

.sitey-url-banner a {
  color: var(--brand);
  text-decoration: none;
  font-weight: 500;
}

.sitey-url-banner a:hover {
  text-decoration: underline;
}

.onboarding-steps {
  margin-top: 1rem;
}

.step {
  display: flex;
  align-items: flex-start;
  gap: 1rem;
  padding: 1rem 0;
  border-bottom: 1px solid var(--border-subtle);
}

.step:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.step.done {
  opacity: 0.6;
}

.step-check {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--bg-input);
  border: 2px solid var(--border-strong);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--font-tiny);
  font-weight: 700;
  flex-shrink: 0;
  margin-top: 2px;
}

.step.done .step-check {
  background: var(--status-ok-bg);
  border-color: var(--status-ok-border);
  color: var(--status-ok-text);
}

.step-body {
  flex: 1;
}

.step-heading {
  font-weight: 600;
  margin-bottom: 0.35rem;
}

.step-desc {
  line-height: 1.55;
  margin-bottom: 0.75rem;
  color: var(--text-muted);
}

.step-desc code {
  background: var(--bg-input);
  border-radius: 3px;
  padding: 0.1em 0.35em;
}

.inline-action {
  margin-top: 0;
}

.step-inline-btn {
  background: none;
  border: none;
  color: var(--brand);
  font-size: var(--font-tiny);
  cursor: pointer;
  padding: 0;
  text-decoration: none;
  display: inline;
}

.step-inline-btn:hover {
  text-decoration: underline;
}

.step-link {
  color: var(--brand);
  text-decoration: none;
  font-size: var(--font-tiny);
}

.step-link:hover {
  text-decoration: underline;
}

.step-warning {
  background: var(--status-warn-bg);
  border: 1px solid var(--status-warn-border);
  color: var(--status-warn-text);
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
  font-size: var(--font-tiny);
  line-height: 1.55;
  margin-bottom: 0.5rem;
}

.step-hint {
  font-size: var(--font-tiny);
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
