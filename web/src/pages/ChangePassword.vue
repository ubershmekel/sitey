<template>
  <div class="wrap">
    <form class="card" @submit.prevent="handleSubmit">
      <div class="brand">⬡ Sitey</div>
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
  background: #0f0f0f;
}
.card {
  width: 380px;
  background: #161616;
  border: 1px solid #2a2a2a;
  border-radius: 12px;
  padding: 2.5rem;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}
.brand { font-size: 1.5rem; font-weight: 700; color: #7c6cfc; text-align: center; }
h1 { font-size: 1.2rem; font-weight: 600; text-align: center; color: #e2e2e2; }
.subtitle { font-size: 0.85rem; color: #666; text-align: center; margin-top: -0.75rem; }
label {
  display: flex; flex-direction: column; gap: 0.4rem;
  font-size: 0.85rem; color: #9a9a9a;
}
.hint { color: #555; font-size: 0.78rem; }
input {
  background: #1f1f1f; border: 1px solid #333; border-radius: 6px;
  padding: 0.6rem 0.75rem; color: #e2e2e2; font-size: 0.95rem; outline: none;
  transition: border-color 0.15s;
}
input:focus { border-color: #7c6cfc; }
.btn-primary {
  background: #7c6cfc; color: #fff; border: none; border-radius: 6px;
  padding: 0.7rem; font-size: 0.95rem; font-weight: 600; cursor: pointer;
  transition: opacity 0.15s;
}
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-primary:hover:not(:disabled) { opacity: 0.85; }
.alert { border-radius: 6px; padding: 0.6rem 0.75rem; font-size: 0.85rem; }
.alert.error { background: #2d1414; border: 1px solid #5a1a1a; color: #ff7070; }
.alert.success { background: #122d14; border: 1px solid #1a5a1e; color: #70ff80; }
</style>
