import { createRouter, createWebHistory } from "vue-router";
import { useAuthStore } from "./stores/auth";

// RouterLink uses client-side navigation (prevents default browser anchor behavior).
// If that client navigation errors (stale JS chunk after deploy, preload failure, etc),
// we force a normal browser navigation to the same target as a recovery path.
const ROUTE_ERROR_RECOVERY_KEY = "sitey:route-error-recovery-path";
let pendingRoutePath: string | null = null;

function getRecoveryTargetPath(): string {
  return (
    pendingRoutePath ?? `${window.location.pathname}${window.location.search}`
  );
}

export function recoverFromNavigationError(): boolean {
  const targetPath = getRecoveryTargetPath();
  const lastRecoveryPath = sessionStorage.getItem(ROUTE_ERROR_RECOVERY_KEY);
  // Prevent infinite loops if the target itself keeps failing.
  if (lastRecoveryPath === targetPath) return false;

  sessionStorage.setItem(ROUTE_ERROR_RECOVERY_KEY, targetPath);
  // Hard navigation bypasses the SPA router and asks the browser to load the page directly.
  window.location.assign(targetPath);
  return true;
}

const routes = [
  {
    path: "/login",
    component: () => import("./pages/Login.vue"),
    meta: { public: true },
  },
  {
    path: "/change-password",
    component: () => import("./pages/ChangePassword.vue"),
    meta: { public: true },
  },
  {
    path: "/github/app/callback",
    component: () => import("./pages/GithubAppCallback.vue"),
  },
  { path: "/", component: () => import("./pages/Index.vue") },
  { path: "/projects", component: () => import("./pages/ProjectList.vue") },
  { path: "/domains", component: () => import("./pages/DomainList.vue") },
  { path: "/domains/:id", component: () => import("./pages/DomainDetail.vue") },
  {
    path: "/projects/:id",
    component: () => import("./pages/ProjectDetail.vue"),
  },
  {
    path: "/integrations",
    component: () => import("./pages/Integrations.vue"),
  },
  { path: "/logs", component: () => import("./pages/Logs.vue") },
  { path: "/settings", component: () => import("./pages/Settings.vue") },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to) => {
  // Track the target route so error recovery can navigate to what the user clicked.
  pendingRoutePath = to.fullPath;
  const auth = useAuthStore();

  if (!auth.user && auth.token) {
    // Fire-and-forget: hydrate user data in the background.
    // Auth decisions use isAuthenticated (token-based) so we don't block navigation.
    auth.fetchUser();
  }

  if (!auth.isAuthenticated && !to.meta.public) return "/login";

  if (
    auth.isAuthenticated &&
    auth.needsPasswordChange &&
    to.path !== "/change-password"
  ) {
    return "/change-password";
  }

  if (auth.isAuthenticated && to.path === "/login") return "/";
});

router.onError((error) => {
  if (recoverFromNavigationError()) return;
  // Keep unexpected router errors visible for debugging.
  console.error(error);
});

router.afterEach(() => {
  // Successful navigation means recovery state can be cleared.
  pendingRoutePath = null;
  sessionStorage.removeItem(ROUTE_ERROR_RECOVERY_KEY);
});
