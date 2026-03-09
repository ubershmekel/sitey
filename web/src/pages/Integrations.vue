<template>
  <Layout>
    <div class="page-header">
      <h1>Integrations</h1>
    </div>

    <!-- GitHub App -->
    <section class="section">
      <div class="section-header">
        <div class="integration-title">
          <span class="integration-icon">⑂</span>
          <div>
            <h2>GitHub App</h2>
            <p class="section-hint">Connect a GitHub App to clone repos and receive push webhooks for auto-deploy.</p>
          </div>
        </div>
        <span v-if="appConfig?.configured" class="badge badge-ok">Connected</span>
        <span v-else class="badge badge-idle">Not connected</span>
      </div>

      <div v-if="appCreated" class="alert success" style="margin-bottom:1.25rem">
        GitHub App created and connected successfully.
      </div>

      <div v-if="appConfig?.configured" class="connected-body">
        <div class="meta-row">
          <span class="meta-label">App ID</span>
          <span class="meta-value">{{ appConfig.appId }}</span>
        </div>

        <div v-if="repoStatusLoading" class="section-hint">Checking installations…</div>
        <template v-else-if="!repoStatusError">
          <div class="meta-row">
            <span class="meta-label">Installations</span>
            <span class="meta-value">{{ repoInstallations }}</span>
          </div>
          <div class="meta-row">
            <span class="meta-label">Repositories visible</span>
            <span class="meta-value">{{ repoCount }}</span>
          </div>
          <p v-if="repoInstallations === 0" class="section-hint warn">
            App is created but not installed on any account or org yet —
            project autocomplete won't see any repositories.
            <a v-if="repoInstallUrl" :href="repoInstallUrl" target="_blank" rel="noopener">Install app on GitHub →</a>
          </p>
        </template>
        <p v-else class="section-hint warn">{{ repoStatusError }}</p>

        <div class="action-row">
          <a v-if="repoInstallUrl && repoInstallations > 0" :href="repoInstallUrl" target="_blank" rel="noopener" class="btn-ghost">
            Manage on GitHub
          </a>
          <button class="btn-danger btn-sm" @click="clearAppConfig">Disconnect</button>
        </div>
      </div>

      <template v-else>
        <p class="section-hint">
          Click below to create and connect a GitHub App in one step.
          Sitey will open GitHub with everything pre-filled — just click <strong>Create GitHub App</strong>.
        </p>

        <div v-if="manifestDomains.length > 1" class="domain-select-row">
          <label class="domain-label" for="manifest-domain">Domain for GitHub App</label>
          <select id="manifest-domain" v-model="selectedDomainId" @change="fetchManifest" class="domain-select">
            <option v-for="d in manifestDomains" :key="d.id" :value="d.id">{{ d.hostname }}</option>
          </select>
        </div>

        <p class="section-hint warn" v-if="manifestLocalhost">
          No domain configured — the automatic flow requires a publicly accessible URL so GitHub
          can redirect back. Use the manual form below for local dev, or add a domain first.
        </p>

        <form
          v-if="manifest"
          :action="manifest.actionUrl"
          method="post"
          target="_blank"
          class="auto-form"
        >
          <input type="hidden" name="manifest" :value="manifest.manifest" />
          <button type="submit" class="btn-primary">
            Create GitHub App automatically →
          </button>
        </form>

        <details class="manual-details">
          <summary>Manual setup (advanced)</summary>
          <form @submit.prevent="saveAppConfig" class="settings-form" style="margin-top:1rem">
            <div v-if="appError" class="alert error">{{ appError }}</div>
            <div v-if="appSuccess" class="alert success">GitHub App config saved.</div>
            <label>
              GitHub App ID
              <input v-model="app.appId" type="text" placeholder="123456" />
            </label>
            <label>
              Private key (PEM)
              <textarea v-model="app.privateKey" rows="6" placeholder="-----BEGIN RSA PRIVATE KEY-----&#10;..." />
            </label>
            <label>
              Webhook secret
              <input v-model="app.webhookSecret" type="password" placeholder="your-webhook-secret" />
            </label>
            <button type="submit" class="btn-primary" :disabled="app.saving">
              {{ app.saving ? 'Saving…' : 'Save' }}
            </button>
          </form>
        </details>
      </template>
    </section>
  </Layout>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import Layout from '../components/Layout.vue'
import { trpc } from '../trpc'

type AppConfig = Awaited<ReturnType<typeof trpc.github.getAppConfig.query>>
type Manifest = Awaited<ReturnType<typeof trpc.github.getManifest.query>>
type AppRepoInfo = Awaited<ReturnType<typeof trpc.github.listAppRepos.query>>

const route = useRoute()
const appConfig = ref<AppConfig | null>(null)
const manifest = ref<Manifest | null>(null)
const manifestDomains = ref<{ id: string; hostname: string }[]>([])
const selectedDomainId = ref<string | null>(null)
const app = reactive({ appId: '', privateKey: '', webhookSecret: '', saving: false })
const appError = ref('')
const appSuccess = ref(false)
const repoStatusLoading = ref(false)
const repoStatusError = ref('')
const repoInstallations = ref(0)
const repoCount = ref(0)
const repoInstallUrl = ref('')
const appCreated = computed(() => route.query.app_created === '1')
const manifestLocalhost = computed(() => {
  if (selectedDomainId.value) {
    const d = manifestDomains.value.find(x => x.id === selectedDomainId.value)
    return d?.hostname === 'localhost'
  }
  return manifestDomains.value.length === 0
})

async function fetchManifest() {
  try {
    const mf = await trpc.github.getManifest.query(
      selectedDomainId.value ? { domainId: selectedDomainId.value } : {},
    )
    manifest.value = mf
    manifestDomains.value = mf.domains
    if (!selectedDomainId.value && mf.domains.length === 1) {
      selectedDomainId.value = mf.domains[0].id
    }
  } catch { /* ignore */ }
}

async function fetchRepoInfo() {
  repoStatusLoading.value = true
  repoStatusError.value = ''
  try {
    const info: AppRepoInfo = await trpc.github.listAppRepos.query()
    repoInstallations.value = info.installations
    repoCount.value = info.repos.length
    repoInstallUrl.value = info.app.installUrl ?? ''
  } catch (e: unknown) {
    repoInstallations.value = 0
    repoCount.value = 0
    repoInstallUrl.value = ''
    repoStatusError.value = (e as { message?: string })?.message ?? 'Could not read GitHub App installation status.'
  } finally {
    repoStatusLoading.value = false
  }
}

async function fetchAppConfig() {
  try {
    const config = await trpc.github.getAppConfig.query()
    appConfig.value = config
    if (config.appId) app.appId = config.appId
    if (config.configured) {
      await fetchRepoInfo()
    } else {
      repoInstallations.value = 0
      repoCount.value = 0
      repoInstallUrl.value = ''
      repoStatusError.value = ''
    }
  } catch { /* ignore */ }
  await fetchManifest()
}

async function saveAppConfig() {
  appError.value = ''
  appSuccess.value = false
  app.saving = true
  try {
    await trpc.github.setAppConfig.mutate({
      appId: app.appId,
      privateKey: app.privateKey,
      webhookSecret: app.webhookSecret,
    })
    appSuccess.value = true
    await fetchAppConfig()
  } catch (e: unknown) {
    appError.value = (e as { message?: string })?.message ?? 'Failed'
  } finally {
    app.saving = false
  }
}

async function clearAppConfig() {
  if (!confirm('Clear GitHub App configuration?')) return
  await trpc.github.clearAppConfig.mutate()
  appConfig.value = null
  app.appId = ''; app.privateKey = ''; app.webhookSecret = ''
  repoInstallations.value = 0
  repoCount.value = 0
  repoInstallUrl.value = ''
  repoStatusError.value = ''
}

onMounted(fetchAppConfig)
</script>

<style scoped>
.page-header { margin-bottom: 2rem; }
h1 { font-size: 1.4rem; font-weight: 600; }

.section {
  background: #161616;
  border: 1px solid #2a2a2a;
  border-radius: 10px;
  padding: 1.75rem;
  margin-bottom: 1.5rem;
}

.section-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1.5rem;
}

.integration-title {
  display: flex;
  align-items: flex-start;
  gap: 0.85rem;
}

.integration-icon {
  font-size: 1.4rem;
  line-height: 1;
  margin-top: 2px;
  color: #9a9a9a;
}

.section-header h2 {
  font-size: 1rem;
  font-weight: 600;
  margin-bottom: 0.25rem;
}

.section-hint {
  font-size: 0.83rem;
  color: #666;
  margin: 0;
  line-height: 1.5;
}

.section-hint a { color: #7c6cfc; }

.section-hint.warn {
  color: #c09a30;
  background: #1e1800;
  border: 1px solid #3a3000;
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
  margin-top: 1rem;
}

.badge {
  font-size: 0.78rem;
  padding: 0.2rem 0.6rem;
  border-radius: 4px;
  white-space: nowrap;
  flex-shrink: 0;
}
.badge-ok   { background: #0e2a14; color: #40c060; }
.badge-idle { background: #1f1f1f; color: #666; border: 1px solid #333; }

.connected-body {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.meta-row {
  display: flex;
  gap: 0.75rem;
  font-size: 0.85rem;
}
.meta-label { color: #555; min-width: 140px; }
.meta-value { color: #ccc; }

.action-row {
  display: flex;
  gap: 0.75rem;
  margin-top: 1rem;
}

.domain-select-row {
  display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1.25rem;
}
.domain-label { font-size: 0.83rem; color: #666; white-space: nowrap; }
.domain-select {
  background: #1f1f1f; border: 1px solid #333; border-radius: 6px;
  padding: 0.45rem 0.6rem; color: #e2e2e2; font-size: 0.88rem; flex: 1;
}

.auto-form { margin-bottom: 1.25rem; }

.manual-details { margin-top: 1rem; }
.manual-details summary {
  font-size: 0.83rem; color: #555; cursor: pointer; user-select: none;
}
.manual-details summary:hover { color: #888; }

.settings-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  max-width: 480px;
}

label {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  font-size: 0.85rem;
  color: #9a9a9a;
}

input, textarea, select {
  background: #1f1f1f;
  border: 1px solid #333;
  border-radius: 6px;
  padding: 0.6rem 0.75rem;
  color: #e2e2e2;
  font-size: 0.9rem;
  outline: none;
  transition: border-color 0.15s;
  font-family: inherit;
}
input:focus, textarea:focus { border-color: #7c6cfc; }
textarea { resize: vertical; font-family: monospace; font-size: 0.82rem; }

.btn-primary {
  background: #7c6cfc; color: #fff; border: none; border-radius: 6px;
  padding: 0.6rem 1.25rem; font-size: 0.9rem; font-weight: 600; cursor: pointer;
  transition: opacity 0.15s;
}
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-primary:hover:not(:disabled) { opacity: 0.85; }

.btn-ghost {
  background: none; color: #9a9a9a; border: 1px solid #333; border-radius: 6px;
  padding: 0.5rem 1rem; font-size: 0.85rem; cursor: pointer; text-decoration: none;
  display: inline-flex; align-items: center;
  transition: border-color 0.15s, color 0.15s;
}
.btn-ghost:hover { border-color: #666; color: #e2e2e2; }

.btn-danger {
  background: #5a1a1a; color: #ff8080; border: none; border-radius: 6px;
  padding: 0.5rem 1rem; font-size: 0.85rem; cursor: pointer;
  transition: background 0.15s;
}
.btn-danger:hover { background: #7a2020; }

.btn-sm { padding: 0.25rem 0.6rem; font-size: 0.8rem; }

.alert {
  border-radius: 6px; padding: 0.6rem 0.75rem; font-size: 0.85rem;
}
.alert.error { background: #2d1414; border: 1px solid #5a1a1a; color: #ff7070; }
.alert.success { background: #122d14; border: 1px solid #1a5a1e; color: #70ff80; }
</style>
