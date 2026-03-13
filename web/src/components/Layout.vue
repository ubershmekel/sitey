<template>
  <div class="layout">
    <div class="sidebar-header">
      <RouterLink to="/" class="logo-link">
        <SiteyLogo class="logo" />
      </RouterLink>
    </div>

    <nav class="app-nav">
      <RouterLink to="/" class="nav-item narrow-only" active-class="active">
        <svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="1.5,8.5 8,2 14.5,8.5"/>
          <path d="M3.5 7.8V14h3.3v-3.5h2.4V14h3.3V7.8"/>
        </svg>
        <span class="label">Dashboard</span>
      </RouterLink>
      <RouterLink to="/projects" class="nav-item" active-class="active">
        <svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="2" width="5" height="5" rx="1"/>
          <rect x="9" y="2" width="5" height="5" rx="1"/>
          <rect x="2" y="9" width="5" height="5" rx="1"/>
          <rect x="9" y="9" width="5" height="5" rx="1"/>
        </svg>
        <span class="label">Projects</span>
      </RouterLink>
      <RouterLink to="/domains" class="nav-item" active-class="active">
        <svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="8" cy="8" r="6"/>
          <path d="M8 2c-2 2.5-2 9.5 0 12M8 2c2 2.5 2 9.5 0 12"/>
          <line x1="2" y1="8" x2="14" y2="8"/>
        </svg>
        <span class="label">Domains</span>
      </RouterLink>
      <RouterLink to="/integrations" class="nav-item" active-class="active">
        <svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6.5 9.5a3.5 3.5 0 0 0 4.95 0l1.5-1.5a3.5 3.5 0 0 0-4.95-4.95l-.75.75"/>
          <path d="M9.5 6.5a3.5 3.5 0 0 0-4.95 0l-1.5 1.5a3.5 3.5 0 0 0 4.95 4.95l.75-.75"/>
        </svg>
        <span class="label">Integrations</span>
      </RouterLink>
      <RouterLink to="/logs" class="nav-item" active-class="active">
        <svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
          <line x1="2" y1="4" x2="14" y2="4"/>
          <line x1="2" y1="8" x2="14" y2="8"/>
          <line x1="2" y1="12" x2="10" y2="12"/>
        </svg>
        <span class="label">Logs</span>
      </RouterLink>
      <RouterLink to="/settings" class="nav-item" active-class="active">
        <svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
          <circle cx="8" cy="8" r="2.5"/>
          <path d="M8 1.5V3M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1"/>
        </svg>
        <span class="label">Settings</span>
      </RouterLink>
    </nav>

    <div class="sidebar-footer">
      <span class="user-email">{{ auth.user?.email }}</span>
      <button class="logout-btn" @click="auth.logout(); router.push('/login')">
        Logout
      </button>
    </div>

    <div class="main-area">
      <main class="content">
        <slot />
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import SiteyLogo from './SiteyLogo.vue'

const auth = useAuthStore()
const router = useRouter()

watch(() => auth.needsPasswordChange, (needs) => {
  if (needs) router.push('/change-password')
})
</script>

<style scoped>
.layout {
  display: grid;
  min-height: 100vh;
  grid-template-columns: 220px 1fr;
  grid-template-rows: auto 1fr auto;
  grid-template-areas:
    "sidebar-header main"
    "app-nav        main"
    "sidebar-footer main";
}

/* ── Sidebar column ── */
.sidebar-header {
  grid-area: sidebar-header;
  background: var(--bg-card);
  border-right: 1px solid var(--border-default);
  border-bottom: 1px solid var(--border-default);
  padding: 1.25rem 1.25rem 1rem;
}

.logo-link { text-decoration: none; display: block; }

.logo {
  font-size: var(--font-large);
  font-weight: 700;
  color: var(--brand);
  letter-spacing: -0.03em;
}

.app-nav {
  grid-area: app-nav;
  background: var(--bg-card);
  border-right: 1px solid var(--border-default);
  padding: 0.75rem 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sidebar-footer {
  grid-area: sidebar-footer;
  background: var(--bg-card);
  border-right: 1px solid var(--border-default);
  border-top: 1px solid var(--border-default);
  padding: 1rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.user-email {
  font-size: var(--font-tiny);
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.logout-btn {
  background: none;
  border: 1px solid var(--border-default);
  color: var(--text-secondary);
  padding: 0.35rem 0.75rem;
  border-radius: 5px;
  cursor: pointer;
  font-size: var(--font-tiny);
  transition: border-color 0.15s, color 0.15s;
}
.logout-btn:hover { border-color: var(--text-muted); color: var(--text-primary); }

/* ── Nav items ── */
.nav-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border-radius: 6px;
  color: var(--text-secondary);
  text-decoration: none;
  transition: background 0.15s, color 0.15s;
}
.nav-item:hover { background: var(--bg-input); color: var(--text-primary); }
.nav-item.active { background: var(--brand-active-bg); color: var(--brand-active-text); }

.icon { width: 16px; height: 16px; flex-shrink: 0; }

.narrow-only { display: none; }

/* ── Main area ── */
.main-area {
  grid-area: main;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}

.content {
  flex: 1;
  padding: 2rem;
}

/* ── Mobile ── */
@media (max-width: 640px) {
  .layout {
    grid-template-columns: 1fr;
    grid-template-rows: 1fr auto;
    grid-template-areas:
      "main"
      "app-nav";
  }

  .sidebar-header,
  .sidebar-footer {
    display: none;
  }

  .narrow-only { display: flex; }

  .app-nav {
    border-right: none;
    border-top: 1px solid var(--border-default);
    padding: 0;
    gap: 0;
  }

  .nav-item {
    padding: 0.85rem 1.25rem;
    border-radius: 0;
    font-size: var(--font-tiny);
    border-bottom: 1px solid var(--border-default);
  }

  .nav-item:last-child {
    border-bottom: none;
  }

  .content {
    padding: 1rem;
  }
}
</style>
