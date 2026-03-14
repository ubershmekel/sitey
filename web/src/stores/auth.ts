import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { trpc } from '../trpc'

type User = { id: string; email: string; mustChangePassword: boolean }

function toAuthErrorMessage(error: unknown, fallback: string) {
  const message = (error as { message?: string })?.message?.trim()
  if (!message) return fallback

  const lowered = message.toLowerCase()
  const isApiUnavailable =
    lowered.includes('unexpected end of json input') ||
    lowered.includes("failed to execute 'json' on 'response'") ||
    lowered.includes('failed to fetch') ||
    lowered.includes('networkerror') ||
    lowered.includes('network request failed')

  if (isApiUnavailable) {
    return 'Failed to reach Sitey API. Is it up and is your network OK?'
  }

  return message
}

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string | null>(localStorage.getItem('sitey_token'))
  const user = ref<User | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  const isAuthenticated = computed(() => !!token.value)
  const needsPasswordChange = computed(() => user.value?.mustChangePassword ?? false)

  function setToken(t: string | null) {
    token.value = t
    if (t) {
      localStorage.setItem('sitey_token', t)
    } else {
      localStorage.removeItem('sitey_token')
    }
  }

  async function fetchUser() {
    if (!token.value) return
    try {
      const me = await trpc.auth.whoami.query()
      user.value = me
    } catch {
      setToken(null)
      user.value = null
    }
  }

  async function login(email: string, password: string) {
    error.value = null
    loading.value = true
    try {
      const res = await trpc.auth.login.mutate({ email, password })
      setToken(res.token)
      user.value = { id: res.id, email: res.email, mustChangePassword: res.mustChangePassword }
      return { mustChangePassword: res.mustChangePassword }
    } catch (e: unknown) {
      const msg = toAuthErrorMessage(e, 'Login failed')
      error.value = msg
      throw e
    } finally {
      loading.value = false
    }
  }

  async function changePassword(currentPassword: string, newPassword: string) {
    error.value = null
    loading.value = true
    try {
      const res = await trpc.auth.changePassword.mutate({ currentPassword, newPassword })
      setToken(res.token)
      await fetchUser()
    } catch (e: unknown) {
      const msg = (e as { message?: string })?.message ?? 'Failed to change password'
      error.value = msg
      throw e
    } finally {
      loading.value = false
    }
  }

  function logout() {
    setToken(null)
    user.value = null
  }

  return {
    token, user, loading, error,
    isAuthenticated, needsPasswordChange,
    login, changePassword, logout, fetchUser, setToken,
  }
})
