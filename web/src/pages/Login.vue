<template>
  <div class="login-wrap">
    <form class="login-card" @submit.prevent="handleLogin">
      <SiteyLogo class="brand" />
      <h1>Sign in</h1>

      <div v-if="auth.error" class="alert error">{{ auth.error }}</div>

      <label>
        Email
        <input v-model="email" type="email" autocomplete="email" required placeholder="admin@sitey.local" />
      </label>

      <label>
        Password
        <input v-model="password" type="password" autocomplete="current-password" required />
      </label>

      <button type="submit" :disabled="auth.loading" class="btn-primary">
        {{ auth.loading ? 'Signing in…' : 'Sign in' }}
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

const email = ref('')
const password = ref('')

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
  background: #0f0f0f;
}

.login-card {
  width: 360px;
  background: #161616;
  border: 1px solid #2a2a2a;
  border-radius: 12px;
  padding: 2.5rem;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.brand {
  font-size: 1.5rem;
  font-weight: 700;
  color: #7c6cfc;
  justify-content: center;
  margin-bottom: -0.5rem;
}

h1 {
  font-size: 1.2rem;
  font-weight: 600;
  text-align: center;
  color: #e2e2e2;
}

label {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  font-size: 0.85rem;
  color: #9a9a9a;
}

input {
  background: #1f1f1f;
  border: 1px solid #333;
  border-radius: 6px;
  padding: 0.6rem 0.75rem;
  color: #e2e2e2;
  font-size: 0.95rem;
  outline: none;
  transition: border-color 0.15s;
}
input:focus { border-color: #7c6cfc; }

.btn-primary {
  background: #7c6cfc;
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 0.7rem;
  font-size: 0.95rem;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
}
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-primary:hover:not(:disabled) { opacity: 0.85; }

.alert.error {
  background: #2d1414;
  border: 1px solid #5a1a1a;
  color: #ff7070;
  border-radius: 6px;
  padding: 0.6rem 0.75rem;
  font-size: 0.85rem;
}
</style>
