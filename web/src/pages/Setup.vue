<template>
  <div class="setup-wrap">
    <form class="setup-card" @submit.prevent="handleSetup">
      <SiteyLogo class="brand" />
      <h1>Welcome — let's get you set up</h1>
      <p class="subtitle">Create your admin account to get started.</p>

      <div v-if="error" class="alert error">{{ error }}</div>

      <label>
        Email
        <input v-model="email" type="email" autocomplete="email" required placeholder="you@example.com" />
      </label>

      <label>
        Password
        <input v-model="password" type="password" autocomplete="new-password" required placeholder="at least 12 characters" />
      </label>

      <button type="submit" :disabled="loading" class="btn-primary">
        {{ loading ? 'Creating account…' : 'Create account' }}
      </button>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { trpc } from '../trpc'
import { useAuthStore } from '../stores/auth'
import SiteyLogo from '../components/SiteyLogo.vue'

const router = useRouter()
const auth = useAuthStore()

const email = ref('')
const password = ref('')
const loading = ref(false)
const error = ref('')

async function handleSetup() {
  error.value = ''
  loading.value = true
  try {
    const result = await trpc.setup.complete.mutate({ email: email.value, password: password.value })
    auth.setToken(result.token)
    await auth.fetchUser()
    router.push('/')
  } catch (e: any) {
    error.value = e?.message ?? 'Setup failed.'
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.setup-wrap {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #0f0f0f;
}

.setup-card {
  width: 400px;
  background: #161616;
  border: 1px solid #2a2a2a;
  border-radius: 12px;
  padding: 2.5rem;
  --btn-primary-padding: 0.7rem;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.brand {
  font-size: var(--font-huge);
  font-weight: 700;
  color: #7c6cfc;
  justify-content: center;
  margin-bottom: -0.5rem;
}

h1 {
  font-size: var(--font-large);
  font-weight: 600;
  text-align: center;
  color: #e2e2e2;
  margin: 0;
}

.subtitle {
  text-align: center;
  color: #666;
  font-size: var(--font-tiny);
  margin: -0.5rem 0 0;
}

label {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  color: #9a9a9a;
}

input {
  background: #1f1f1f;
  border: 1px solid #333;
  border-radius: 6px;
  padding: 0.6rem 0.75rem;
  color: #e2e2e2;
  outline: none;
  transition: border-color 0.15s;
}
input:focus { border-color: #7c6cfc; }

.alert.error {
  background: #2d1414;
  border: 1px solid #5a1a1a;
  color: #ff7070;
  border-radius: 6px;
  padding: 0.6rem 0.75rem;
}
</style>
