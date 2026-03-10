<template>
  <div class="wrap">
    <form class="card" @submit.prevent="handleSubmit">
      <SiteyLogo class="brand" />
      <h1>Change password</h1>
      <p class="subtitle">You must set a new password before continuing.</p>

      <div v-if="error" class="alert error">{{ error }}</div>
      <div v-if="success" class="alert success">Password changed! Redirecting…</div>

      <label>
        Current password
        <input v-model="current" type="password" autocomplete="current-password" required />
      </label>

      <label>
        New password <span class="hint">(min 12 chars)</span>
        <input v-model="next" type="password" autocomplete="new-password" required minlength="12" />
      </label>

      <label>
        Confirm new password
        <input v-model="confirm" type="password" autocomplete="new-password" required />
      </label>

      <button type="submit" :disabled="loading" class="btn-primary">
        {{ loading ? 'Saving…' : 'Set new password' }}
      </button>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import SiteyLogo from '../components/SiteyLogo.vue'

const auth = useAuthStore()
const router = useRouter()

const current = ref('')
const next = ref('')
const confirm = ref('')
const loading = ref(false)
const error = ref('')
const success = ref(false)

async function handleSubmit() {
  error.value = ''
  if (next.value !== confirm.value) {
    error.value = 'Passwords do not match'
    return
  }
  loading.value = true
  try {
    await auth.changePassword(current.value, next.value)
    success.value = true
    setTimeout(() => router.push('/'), 1000)
  } catch (e: unknown) {
    error.value = (e as { message?: string })?.message ?? 'Failed'
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.wrap {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-page);
}
.card {
  width: 380px;
  background: var(--bg-card);
  border: 1px solid var(--border-default);
  border-radius: 12px;
  padding: 2.5rem;
  --btn-primary-padding: 0.7rem;
  --btn-primary-font-size: 0.95rem;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}
.brand { font-size: 1.5rem; font-weight: 700; color: var(--brand); justify-content: center; }
h1 { font-size: 1.2rem; font-weight: 600; text-align: center; color: var(--text-primary); }
.subtitle { font-size: 0.85rem; color: var(--text-muted); text-align: center; margin-top: -0.75rem; }
label {
  display: flex; flex-direction: column; gap: 0.4rem;
  font-size: 0.85rem; color: var(--text-secondary);
}
.hint { color: var(--text-muted); font-size: 0.78rem; }
input {
  background: var(--bg-input); border: 1px solid var(--border-strong); border-radius: 6px;
  padding: 0.6rem 0.75rem; color: var(--text-primary); font-size: 0.95rem; outline: none;
  transition: border-color 0.15s;
}
input:focus { border-color: var(--brand); }
.alert { border-radius: 6px; padding: 0.6rem 0.75rem; font-size: 0.85rem; }
.alert.error { background: var(--status-err-bg); border: 1px solid var(--status-err-border); color: var(--status-err-text); }
.alert.success { background: var(--status-ok-bg); border: 1px solid var(--status-ok-border); color: var(--status-ok-text); }
</style>
