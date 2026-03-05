import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { trpc } from '../trpc'

type User = { id: string; email: string; mustChangePassword: boolean }

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
      user.value = { id: '', email: res.email, mustChangePassword: res.mustChangePassword }
      await fetchUser()
      return { mustChangePassword: res.mustChangePassword }
    } catch (e: unknown) {
      const msg = (e as { message?: string })?.message ?? 'Login failed'
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
    login, changePassword, logout, fetchUser,
  }
})
