<template>
  <Layout>
    <div class="page-header">
      <h1>Settings</h1>
    </div>

    <!-- Public Site URL -->
    <section class="settings-section">
      <h2>Public Sitey URL</h2>
      <p class="section-hint">
        Used for GitHub callback URLs, webhook setup links, and admin-facing links.
        This must be publicly reachable.
      </p>

      <div class="meta-row">
        <span class="meta-label">Effective URL (in use)</span>
        <span class="meta-value">{{ publicSiteUrlInfo?.effectiveUrl ?? 'Not configured' }}</span>
      </div>
      <div class="meta-row">
        <span class="meta-label">Source</span>
        <span class="meta-value">{{ publicUrlSourceLabel }}</span>
      </div>
      <div class="meta-row" v-if="publicSiteUrlInfo?.wildcardUrl">
        <span class="meta-label">Wildcard candidate</span>
        <span class="meta-value">{{ publicSiteUrlInfo.wildcardUrl }}</span>
      </div>
      <p class="section-hint compact" v-if="publicSiteUrlInfo?.wildcardUrl">
        Wildcard candidate is the automatic URL derived from your wildcard domain. Effective URL is what Sitey is
        currently using.
      </p>

      <form @submit.prevent="savePublicSiteUrl" class="settings-form" style="margin-top:1rem">
        <div v-if="publicSiteUrlError" class="alert error">{{ publicSiteUrlError }}</div>
        <div v-if="publicSiteUrlSuccess" class="alert success">Public Site URL saved.</div>
        <label>
          Override URL
          <input v-model="publicSiteUrl.value" type="text" placeholder="https://sitey.example.com" autocomplete="off" />
        </label>
        <div class="button-row">
          <button type="submit" class="btn-primary" :disabled="publicSiteUrl.saving">
            {{ publicSiteUrl.saving ? 'Saving...' : 'Save URL' }}
          </button>
          <button v-if="publicSiteUrlInfo?.configuredUrl" type="button" class="btn-ghost"
            :disabled="publicSiteUrl.saving" @click="clearPublicSiteUrl">
            Use automatic URL
          </button>
        </div>
      </form>
    </section>

    <!-- Change Password -->
    <section class="settings-section">
      <h2>Change password</h2>
      <form @submit.prevent="changePassword" class="settings-form">
        <div v-if="pwError" class="alert error">{{ pwError }}</div>
        <div v-if="pwSuccess" class="alert success">Password changed successfully.</div>
        <label>
          Current password
          <input v-model="pw.current" type="password" required autocomplete="current-password" />
        </label>
        <label>
          New password <span class="hint">(min 12 chars)</span>
          <input v-model="pw.next" type="password" required minlength="12" autocomplete="new-password" />
        </label>
        <label>
          Confirm new password
          <input v-model="pw.confirm" type="password" required autocomplete="new-password" />
        </label>
        <button type="submit" class="btn-primary" :disabled="pw.saving">
          {{ pw.saving ? 'Saving…' : 'Change password' }}
        </button>
      </form>
    </section>

    <!-- Caddy config debug -->
    <section class="settings-section">
      <h2>Active Caddy config</h2>
      <p class="section-hint">The Caddyfile currently pushed to Caddy. Useful for debugging HTTPS / routing issues.</p>
      <button class="btn-ghost" @click="loadCaddyfile">{{ caddyfileLoading ? 'Loading…' : 'Show config' }}</button>
      <pre v-if="caddyfile" class="block-code"
        style="margin-top:0.75rem;white-space:pre;overflow-x:auto">{{ caddyfile }}</pre>
    </section>

    <!-- About -->
    <section class="settings-section about">
      <h2>About Sitey</h2>
      <p>Self-hosted PaaS. Domain-first. Vibed with ❤️ on TypeScript + Vue 3 + Caddy.</p>
      <p class="hint">To reset the admin password, run on the host:</p>
      <code class="block-code">docker compose exec sitey-api node dist/services/bootstrap.js reset</code>
    </section>
  </Layout>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import Layout from '../components/Layout.vue'
import { trpc } from '../trpc'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
type PublicSiteUrlInfo = Awaited<ReturnType<typeof trpc.system.getPublicSiteUrl.query>>

const publicSiteUrlInfo = ref<PublicSiteUrlInfo | null>(null)
const publicSiteUrl = reactive({ value: '', saving: false })
const publicSiteUrlError = ref('')
const publicSiteUrlSuccess = ref(false)

const publicUrlSourceLabel = computed(() => {
  const source = publicSiteUrlInfo.value?.source
  if (source === 'config') return 'Saved override'
  if (source === 'wildcard') return 'Wildcard domain (sitey.<base>)'
  if (source === 'env') return 'SITEY_URL environment variable'
  return 'Not resolved'
})

async function loadPublicSiteUrl() {
  try {
    const info = await trpc.system.getPublicSiteUrl.query()
    publicSiteUrlInfo.value = info
    publicSiteUrl.value = info.configuredUrl ?? ''
  } catch (e: unknown) {
    publicSiteUrlError.value = (e as { message?: string })?.message ?? 'Failed to load Public Site URL.'
  }
}

async function savePublicSiteUrl() {
  publicSiteUrlError.value = ''
  publicSiteUrlSuccess.value = false
  publicSiteUrl.saving = true
  try {
    await trpc.system.setPublicSiteUrl.mutate({ url: publicSiteUrl.value })
    publicSiteUrlSuccess.value = true
    await loadPublicSiteUrl()
  } catch (e: unknown) {
    publicSiteUrlError.value = (e as { message?: string })?.message ?? 'Failed to save Public Site URL.'
  } finally {
    publicSiteUrl.saving = false
  }
}

async function clearPublicSiteUrl() {
  publicSiteUrlError.value = ''
  publicSiteUrlSuccess.value = false
  publicSiteUrl.saving = true
  try {
    await trpc.system.clearPublicSiteUrl.mutate()
    await loadPublicSiteUrl()
  } catch (e: unknown) {
    publicSiteUrlError.value = (e as { message?: string })?.message ?? 'Failed to clear Public Site URL.'
  } finally {
    publicSiteUrl.saving = false
  }
}

// ── Password change ───────────────────────────────────────────────────────────
const pw = reactive({ current: '', next: '', confirm: '', saving: false })
const pwError = ref('')
const pwSuccess = ref(false)

async function changePassword() {
  pwError.value = ''
  pwSuccess.value = false
  if (pw.next !== pw.confirm) { pwError.value = 'Passwords do not match'; return }
  pw.saving = true
  try {
    await auth.changePassword(pw.current, pw.next)
    pwSuccess.value = true
    pw.current = ''; pw.next = ''; pw.confirm = ''
  } catch (e: unknown) {
    pwError.value = (e as { message?: string })?.message ?? 'Failed'
  } finally {
    pw.saving = false
  }
}

// ── Caddy debug ───────────────────────────────────────────────────────────────
const caddyfile = ref('')
const caddyfileLoading = ref(false)

async function loadCaddyfile() {
  caddyfileLoading.value = true
  try {
    caddyfile.value = await trpc.domains.getCaddyfile.query()
  } finally {
    caddyfileLoading.value = false
  }
}

onMounted(loadPublicSiteUrl)

</script>

<style scoped>
.page-header {
  margin-bottom: 2rem;
}

h1 {
  font-weight: 600;
}

.settings-section {
  background: var(--bg-card);
  border: 1px solid var(--border-default);
  border-radius: 10px;
  padding: 1.75rem;
  margin-bottom: 1.5rem;
}

.settings-section h2 {
  font-size: var(--font-medium);
  font-weight: 600;
  margin-bottom: 1rem;
}

.section-hint {
  font-size: var(--font-tiny);
  color: var(--text-muted);
  margin-bottom: 1.25rem;
  margin-top: -0.5rem;
}

.meta-row {
  display: grid;
  grid-template-columns: 190px minmax(0, 1fr);
  align-items: start;
  gap: 1rem;
  margin-bottom: 0.35rem;
  font-size: var(--font-tiny);
}

.meta-label {
  color: var(--text-muted);
}

.meta-value {
  color: var(--text-primary);
  font-family: monospace;
  word-break: break-all;
  text-align: left;
}

.section-hint.compact {
  margin-top: 0.5rem;
  margin-bottom: 0;
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

.hint {
  color: var(--text-muted);
}

input,
textarea {
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

.form-row {
  display: flex;
  gap: 0.75rem;
}

.button-row {
  display: flex;
  gap: 0.75rem;
  align-items: center;
}

.settings-form>.btn-primary {
  align-self: flex-start;
}

.app-status {
  margin-bottom: 1rem;
}

.badge {
  padding: 0.2rem 0.6rem;
  border-radius: 4px;
}

.badge-ok {
  background: var(--status-ok-bg);
  color: var(--status-ok-text);
}

.badge-warn {
  background: var(--status-warn-bg);
  color: var(--status-warn-text);
}

.btn-danger {
  background: var(--status-err-bg);
  color: var(--status-err-text);
  border: none;
  border-radius: 6px;
  padding: 0.6rem 1.25rem;
  cursor: pointer;
  transition: background 0.15s;
}

.btn-danger:hover {
  background: #7a2020;
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

.section-hint.warn {
  color: var(--status-warn-text);
  background: var(--status-warn-bg);
  border: 1px solid var(--status-warn-border);
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
}

.section-hint.warn code {
  background: #2a2200;
  border-radius: 3px;
  padding: 0.1em 0.3em;
}

.section-hint a {
  color: var(--brand);
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

.btn-sm {
  padding: 0.25rem 0.6rem;
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
  transition: border-color 0.15s, color 0.15s;
}

.btn-ghost:hover {
  border-color: var(--text-muted);
  color: var(--text-primary);
}

.about p {
  font-size: var(--font-tiny);
  color: var(--text-muted);
  margin-bottom: 0.5rem;
}

.block-code {
  display: block;
  background: var(--bg-code);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  padding: 0.75rem 1rem;
  font-family: monospace;
  color: #a0d0a0;
  margin-top: 0.5rem;
  word-break: break-all;
}
</style>
