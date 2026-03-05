import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from './stores/auth'

const routes = [
  { path: '/login', component: () => import('./pages/Login.vue'), meta: { public: true } },
  { path: '/change-password', component: () => import('./pages/ChangePassword.vue'), meta: { public: true } },
  { path: '/', component: () => import('./pages/Dashboard.vue') },
  { path: '/domains/:id', component: () => import('./pages/DomainDetail.vue') },
  { path: '/projects/:id', component: () => import('./pages/ProjectDetail.vue') },
  { path: '/settings', component: () => import('./pages/Settings.vue') },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach(async (to) => {
  const auth = useAuthStore()

  if (!auth.user && auth.token) {
    await auth.fetchUser()
  }

  if (!auth.isAuthenticated && !to.meta.public) {
    return '/login'
  }

  if (auth.isAuthenticated && auth.needsPasswordChange && to.path !== '/change-password') {
    return '/change-password'
  }

  if (auth.isAuthenticated && to.path === '/login') {
    return '/'
  }
})
