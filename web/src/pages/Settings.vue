<template>
  <Layout>
    <div class="page-header">
      <h1>Settings</h1>
    </div>

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
      <pre v-if="caddyfile" class="block-code" style="margin-top:0.75rem;white-space:pre;overflow-x:auto">{{ caddyfile }}</pre>
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
import { ref, reactive } from 'vue'
import Layout from '../components/Layout.vue'
import { trpc } from '../trpc'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()

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

</script>

<style scoped>
.page-header {
  margin-bottom: 2rem;
}

h1 {
  font-size: 1.4rem;
  font-weight: 600;
}

.settings-section {
  background: #161616;
  border: 1px solid #2a2a2a;
  border-radius: 10px;
  padding: 1.75rem;
  margin-bottom: 1.5rem;
}

.settings-section h2 {
  font-size: 1rem;
  font-weight: 600;
  margin-bottom: 1rem;
}

.section-hint {
  font-size: 0.83rem;
  color: #666;
  margin-bottom: 1.25rem;
  margin-top: -0.5rem;
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
  font-size: 0.85rem;
  color: #9a9a9a;
}

.hint {
  color: #555;
  font-size: 0.78rem;
}

input,
textarea {
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

input:focus,
textarea:focus {
  border-color: #7c6cfc;
}

textarea {
  resize: vertical;
  font-family: monospace;
  font-size: 0.82rem;
}

.form-row {
  display: flex;
  gap: 0.75rem;
}

.app-status {
  margin-bottom: 1rem;
}

.badge {
  font-size: 0.8rem;
  padding: 0.2rem 0.6rem;
  border-radius: 4px;
}

.badge-ok {
  background: #0e2a14;
  color: #40c060;
}

.badge-warn {
  background: #2a2206;
  color: #d4a800;
}

.btn-primary {
  background: #7c6cfc;
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 0.6rem 1.25rem;
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
  align-self: flex-start;
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-primary:hover:not(:disabled) {
  opacity: 0.85;
}

.btn-danger {
  background: #5a1a1a;
  color: #ff8080;
  border: none;
  border-radius: 6px;
  padding: 0.6rem 1.25rem;
  font-size: 0.9rem;
  cursor: pointer;
  transition: background 0.15s;
}

.btn-danger:hover {
  background: #7a2020;
}

.alert {
  border-radius: 6px;
  padding: 0.6rem 0.75rem;
  font-size: 0.85rem;
}

.alert.error {
  background: #2d1414;
  border: 1px solid #5a1a1a;
  color: #ff7070;
}

.alert.success {
  background: #122d14;
  border: 1px solid #1a5a1e;
  color: #70ff80;
}

.section-hint.warn {
  color: #c09a30;
  background: #1e1800;
  border: 1px solid #3a3000;
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
}
.section-hint.warn code { background: #2a2200; border-radius: 3px; padding: 0.1em 0.3em; font-size: 0.9em; }
.section-hint a { color: #7c6cfc; }

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

.btn-sm {
  padding: 0.25rem 0.6rem;
  font-size: 0.8rem;
}

.btn-ghost {
  background: none; color: #9a9a9a; border: 1px solid #333; border-radius: 6px;
  padding: 0.5rem 1rem; font-size: 0.85rem; cursor: pointer;
}
.btn-ghost:hover { border-color: #666; color: #e2e2e2; }

.about p {
  font-size: 0.85rem;
  color: #666;
  margin-bottom: 0.5rem;
}

.block-code {
  display: block;
  background: #0a0a0a;
  border: 1px solid #2a2a2a;
  border-radius: 6px;
  padding: 0.75rem 1rem;
  font-family: monospace;
  font-size: 0.82rem;
  color: #a0d0a0;
  margin-top: 0.5rem;
  word-break: break-all;
}
</style>
