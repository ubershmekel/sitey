import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from './stores/auth'
import { trpc } from './trpc'

const routes = [
  { path: '/setup', component: () => import('./pages/Setup.vue'), meta: { public: true } },
  { path: '/login', component: () => import('./pages/Login.vue'), meta: { public: true } },
  { path: '/change-password', component: () => import('./pages/ChangePassword.vue'), meta: { public: true } },
  { path: '/', component: () => import('./pages/ProjectList.vue') },
  { path: '/domains', component: () => import('./pages/Dashboard.vue') },
  { path: '/domains/:id', component: () => import('./pages/DomainDetail.vue') },
  { path: '/projects/:id', component: () => import('./pages/ProjectDetail.vue') },
  { path: '/settings', component: () => import('./pages/Settings.vue') },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
})

// Cached once per session to avoid checking on every navigation
let setupChecked = false
let setupComplete = true

router.beforeEach(async (to) => {
  if (!setupChecked) {
    setupChecked = true
    try {
      const status = await trpc.setup.status.query()
      setupComplete = status.setupComplete
    } catch {
      // API unreachable — fall through; other guards will handle it
    }
  }

  if (!setupComplete && to.path !== '/setup') return '/setup'
  if (setupComplete && to.path === '/setup') return '/login'

  const auth = useAuthStore()

  if (!auth.user && auth.token) {
    await auth.fetchUser()
  }

  if (!auth.isAuthenticated && !to.meta.public) return '/login'

  if (auth.isAuthenticated && auth.needsPasswordChange && to.path !== '/change-password') {
    return '/change-password'
  }

  if (auth.isAuthenticated && to.path === '/login') return '/'
})
