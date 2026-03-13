<template>
  <div class="login-wrap">
    <form class="login-card" @submit.prevent="handleSubmit">
      <SiteyLogo class="brand" />

      <template v-if="isSetup">
        <h1>Welcome 🎉 let's get you set up</h1>
        <p class="subtitle">Create your admin account to get started.</p>
      </template>
      <template v-else>
        <h1>Sign in</h1>
      </template>

      <div v-if="auth.error" class="alert error">{{ auth.error }}</div>
      <div v-if="setupError" class="alert error">{{ setupError }}</div>

      <label>
        Email
        <input v-model="email" type="email" autocomplete="email" required
          :placeholder="isSetup ? 'you@example.com' : 'admin@sitey.local'" />
      </label>

      <label>
        Password
        <input v-model="password" type="password" :autocomplete="isSetup ? 'new-password' : 'current-password'" required
          :placeholder="isSetup ? 'at least 9 characters' : ''" />
      </label>

      <button type="submit" :disabled="auth.loading || setupLoading" class="btn-primary">
        <template v-if="isSetup">{{ setupLoading ? 'Creating account…' : 'Create account' }}</template>
        <template v-else>{{ auth.loading ? 'Signing in…' : 'Sign in' }}</template>
      </button>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { trpc } from '../trpc'
import SiteyLogo from '../components/SiteyLogo.vue'

const auth = useAuthStore()
const router = useRouter()

const email = ref('')
const password = ref('')
const isSetup = ref(false)
const setupLoading = ref(false)
const setupError = ref('')

onMounted(async () => {
  try {
    const status = await trpc.auth.setupStatus.query()
    isSetup.value = !status.setupComplete
  } catch {
    // If we can't reach the API, default to login mode
  }
})

async function handleSubmit() {
  if (isSetup.value) {
    await handleSetup()
  } else {
    await handleLogin()
  }
}

async function handleSetup() {
  setupError.value = ''
  setupLoading.value = true
  try {
    const result = await trpc.auth.setupComplete.mutate({ email: email.value, password: password.value })
    auth.setToken(result.token)
    await auth.fetchUser()
    isSetup.value = false
    router.push('/')
  } catch (e: any) {
    setupError.value = e?.message ?? 'Setup failed.'
  } finally {
    setupLoading.value = false
  }
}

async function handleLogin() {
  try {
    const result = await auth.login(email.value, password.value)
    if (result.mustChangePassword) {
      router.push('/change-password')
    } else {
      router.push('/')
    }
  } catch {
    // error shown via auth.error
  }
}
</script>

<style scoped>
.login-wrap {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-page);
}

.login-card {
  width: 400px;
  background: var(--bg-card);
  border: 1px solid var(--border-default);
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
  color: var(--brand);
  justify-content: center;
  margin-bottom: -0.5rem;
}

h1 {
  font-size: var(--font-large);
  font-weight: 600;
  text-align: center;
  color: var(--text-primary);
}

.subtitle {
  text-align: center;
  color: var(--text-muted);
  font-size: var(--font-tiny);
  margin: -0.5rem 0 0;
}

label {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  color: var(--text-secondary);
}

input {
  background: var(--bg-input);
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  padding: 0.6rem 0.75rem;
  color: var(--text-primary);
  outline: none;
  transition: border-color 0.15s;
}

input:focus {
  border-color: var(--brand);
}

.alert.error {
  background: var(--status-err-bg);
  border: 1px solid var(--status-err-border);
  color: var(--status-err-text);
  border-radius: 6px;
  padding: 0.6rem 0.75rem;
}
</style>
