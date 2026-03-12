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
          <!-- Installation list -->
          <div class="installations-section">
            <div class="installations-header">
              <span class="meta-label">Installed on</span>
              <span class="meta-value" v-if="installations.length === 0">—</span>
            </div>

            <div v-if="installations.length === 0" class="warn-box">
              App is created but not installed on any account or organization yet —
              project autocomplete won't see any repositories.
            </div>

            <ul v-else class="installation-list">
              <li v-for="inst in installations" :key="inst.id" class="installation-item">
                <span class="install-avatar">{{ inst.accountType === 'Organization' ? '⊞' : '○' }}</span>
                <span class="install-login">{{ inst.accountLogin }}</span>
                <span class="install-type">{{ inst.accountType === 'Organization' ? 'org' : 'user' }}</span>
                <span class="install-repos">{{ inst.repoCount }} repo{{ inst.repoCount !== 1 ? 's' : '' }}</span>
              </li>
            </ul>
          </div>

          <!-- Install link — shareable -->
          <div v-if="installUrl" class="install-link-section">
            <p class="section-hint install-link-label">
              Install on another personal account or organization — share this link or open it yourself.
              On the GitHub page, use the <strong>account switcher</strong> at the top to select a personal account or org.
            </p>
            <div class="install-link-row">
              <code class="install-link-url">{{ installUrl }}</code>
              <button class="btn-ghost btn-sm" @click="copyInstallUrl">{{ copied ? 'Copied!' : 'Copy' }}</button>
              <a :href="installUrl" target="_blank" rel="noopener" class="btn-ghost btn-sm">Open →</a>
            </div>
          </div>
        </template>
        <p v-else class="section-hint warn">{{ repoStatusError }}</p>

        <div class="action-row">
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

        <p v-if="manifest?.effectiveSiteUrl" class="section-hint">
          Callback base URL: <code>{{ manifest.effectiveSiteUrl }}</code> (source: {{ manifest.effectiveSiteUrlSource }})
        </p>
        <p class="section-hint warn" v-if="manifestError">{{ manifestError }}</p>

        <form v-if="manifest" :action="manifest.actionUrl" method="post" target="_blank" class="auto-form">
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
type Installation = Extract<AppRepoInfo, { configured: true }>['installations'][number]

const route = useRoute()
const appConfig = ref<AppConfig | null>(null)
const manifest = ref<Manifest | null>(null)
const manifestDomains = ref<{ id: number; hostname: string }[]>([])
const manifestError = ref('')
const selectedDomainId = ref<number | null>(null)
const app = reactive({ appId: '', privateKey: '', webhookSecret: '', saving: false })
const appError = ref('')
const appSuccess = ref(false)
const repoStatusLoading = ref(false)
const repoStatusError = ref('')
const installations = ref<Installation[]>([])
const installUrl = ref<string | null>(null)
const copied = ref(false)
const appCreated = computed(() => route.query.app_created === '1')

async function copyInstallUrl() {
  if (!installUrl.value) return
  await navigator.clipboard.writeText(installUrl.value)
  copied.value = true
  setTimeout(() => { copied.value = false }, 2000)
}

async function fetchManifest() {
  manifestError.value = ''
  try {
    const mf = await trpc.github.getManifest.query(
      selectedDomainId.value ? { domainId: selectedDomainId.value } : {},
    )
    manifest.value = mf
    manifestDomains.value = mf.domains
    if (!selectedDomainId.value && mf.domains.length === 1) {
      selectedDomainId.value = mf.domains[0].id
    }
  } catch (e: unknown) {
    manifest.value = null
    manifestError.value = (e as { message?: string })?.message ?? 'Could not generate GitHub App manifest.'
  }
}

async function fetchRepoInfo() {
  repoStatusLoading.value = true
  repoStatusError.value = ''
  try {
    const info: AppRepoInfo = await trpc.github.listAppRepos.query()
    if (info.configured) {
      installations.value = info.installations
      installUrl.value = info.app.installUrl
    } else {
      installations.value = []
      installUrl.value = null
    }
  } catch (e: unknown) {
    const msg = (e as { message?: string })?.message ?? ''
    // If the app no longer exists on GitHub, clear the stale credentials automatically
    if (msg.includes('Integration not found') || msg.includes('"status":"404"') || msg.includes('404')) {
      await trpc.github.clearAppConfig.mutate()
      appConfig.value = null
      app.appId = ''; app.privateKey = ''; app.webhookSecret = ''
      installations.value = []
      installUrl.value = null
      repoStatusError.value = ''
      await fetchManifest()
      return
    }
    installations.value = []
    repoStatusError.value = msg || 'Could not read GitHub App installation status.'
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
      installations.value = []
      installUrl.value = null
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
  installations.value = []
  installUrl.value = null
  repoStatusError.value = ''
}

onMounted(fetchAppConfig)
</script>

<style scoped>
.page-header {
  margin-bottom: 2rem;
}

h1 {
  font-weight: 600;
}

.section {
  background: var(--bg-card);
  border: 1px solid var(--border-default);
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
  font-size: var(--font-huge);
  line-height: 1;
  margin-top: 2px;
  color: var(--pink);
}

.section-header h2 {
  font-size: var(--font-medium);
  font-weight: 600;
  margin-bottom: 0.25rem;
}

.section-hint {
  font-size: var(--font-tiny);
  color: var(--text-muted);
  margin: 0;
  line-height: 1.5;
}

.section-hint a {
  color: var(--brand);
}

.section-hint.warn {
  color: var(--status-warn-text);
  background: var(--status-warn-bg);
  border: 1px solid var(--status-warn-border);
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
  margin-top: 1rem;
}

.badge {
  padding: 0.2rem 0.6rem;
  border-radius: 4px;
  white-space: nowrap;
  flex-shrink: 0;
}

.badge-ok {
  background: var(--status-ok-bg);
  color: var(--status-ok-text);
}

.badge-idle {
  background: var(--bg-input);
  color: var(--text-muted);
  border: 1px solid var(--border-strong);
}

.connected-body {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.meta-row {
  display: flex;
  gap: 0.75rem;
  font-size: var(--font-tiny);
}

.meta-label {
  color: var(--text-muted);
  min-width: 140px;
  font-size: var(--font-tiny);
}

.meta-value {
  color: var(--text-secondary);
  font-size: var(--font-tiny);
}

.installations-section {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.installations-header {
  display: flex;
  gap: 0.75rem;
  align-items: baseline;
}

.warn-box {
  font-size: var(--font-tiny);
  color: var(--status-warn-text);
  background: var(--status-warn-bg);
  border: 1px solid var(--status-warn-border);
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
}

.installation-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.installation-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: var(--font-tiny);
  padding: 0.4rem 0.6rem;
  background: var(--bg-input);
  border: 1px solid var(--border-default);
  border-radius: 6px;
}

.install-avatar {
  color: var(--text-muted);
  flex-shrink: 0;
}

.install-login {
  font-weight: 500;
  color: var(--text-primary);
  flex: 1;
}

.install-type {
  font-size: var(--font-tiny);
  color: var(--text-muted);
  background: var(--bg-card);
  border: 1px solid var(--border-default);
  border-radius: 3px;
  padding: 0.1rem 0.35rem;
}

.install-repos {
  font-size: var(--font-tiny);
  color: var(--text-muted);
  flex-shrink: 0;
}

.install-link-section {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.75rem;
  background: var(--bg-input);
  border: 1px solid var(--border-default);
  border-radius: 8px;
}

.install-link-label {
  margin: 0;
}

.install-link-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.install-link-url {
  color: var(--text-secondary);
  background: var(--bg-card);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  padding: 0.3rem 0.5rem;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.action-row {
  display: flex;
  gap: 0.75rem;
  margin-top: 0.5rem;
}

.domain-select-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 1.25rem;
}

.domain-label {
  color: var(--text-muted);
  white-space: nowrap;
}

.domain-select {
  background: var(--bg-input);
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  padding: 0.45rem 0.6rem;
  color: var(--text-primary);
  flex: 1;
}

.auto-form {
  margin-bottom: 1.25rem;
}

.manual-details {
  margin-top: 1rem;
}

.manual-details summary {
  font-size: var(--font-tiny);
  color: var(--text-muted);
  cursor: pointer;
  user-select: none;
}

.manual-details summary:hover {
  color: var(--text-secondary);
}

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
  color: var(--text-secondary);
}

input,
textarea,
select {
  background: var(--bg-input);
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  padding: 0.6rem 0.75rem;
  color: var(--text-primary);
  outline: none;
  transition: border-color 0.15s;
  font-family: inherit;
}

input:focus,
textarea:focus {
  border-color: var(--brand);
}

textarea {
  resize: vertical;
  font-family: monospace;
  font-size: var(--font-tiny);
}

.btn-ghost {
  background: none;
  color: var(--text-secondary);
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  padding: 0.5rem 1rem;
  font-size: var(--font-tiny);
  cursor: pointer;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  transition: border-color 0.15s, color 0.15s;
}

.btn-ghost:hover {
  border-color: var(--text-muted);
  color: var(--text-primary);
}

.btn-danger {
  background: var(--status-err-bg);
  color: var(--status-err-text);
  border: none;
  border-radius: 6px;
  padding: 0.5rem 1rem;
  font-size: var(--font-tiny);
  cursor: pointer;
  transition: background 0.15s;
}

.btn-danger:hover {
  background: #7a2020;
}

.btn-sm {
  padding: 0.25rem 0.6rem;
  font-size: var(--font-tiny);
}

.alert {
  border-radius: 6px;
  padding: 0.6rem 0.75rem;
}

.alert.error {
  background: var(--status-err-bg);
  border: 1px solid var(--status-err-border);
  color: var(--status-err-text);
}

.alert.success {
  background: var(--status-ok-bg);
  border: 1px solid var(--status-ok-border);
  color: var(--status-ok-text);
}
</style>
