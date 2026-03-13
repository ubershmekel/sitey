import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from './stores/auth'

const routes = [
  { path: '/login', component: () => import('./pages/Login.vue'), meta: { public: true } },
  { path: '/change-password', component: () => import('./pages/ChangePassword.vue'), meta: { public: true } },
  { path: '/github/app/callback', component: () => import('./pages/GithubAppCallback.vue') },
  { path: '/', component: () => import('./pages/Index.vue') },
  { path: '/projects', component: () => import('./pages/ProjectList.vue') },
  { path: '/domains', component: () => import('./pages/DomainList.vue') },
  { path: '/domains/:id', component: () => import('./pages/DomainDetail.vue') },
  { path: '/projects/:id', component: () => import('./pages/ProjectDetail.vue') },
  { path: '/integrations', component: () => import('./pages/Integrations.vue') },
  { path: '/logs', component: () => import('./pages/Logs.vue') },
  { path: '/settings', component: () => import('./pages/Settings.vue') },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach(async (to) => {
  const auth = useAuthStore()

  if (!auth.user && auth.token) {
    // Fire-and-forget: hydrate user data in the background.
    // Auth decisions use isAuthenticated (token-based) so we don't block navigation.
    auth.fetchUser()
  }

  if (!auth.isAuthenticated && !to.meta.public) return '/login'

  if (auth.isAuthenticated && auth.needsPasswordChange && to.path !== '/change-password') {
    return '/change-password'
  }

  if (auth.isAuthenticated && to.path === '/login') return '/'
})
