<template>
  <div class="layout">
    <nav class="sidebar">
      <div class="sidebar-header">
        <RouterLink to="/" class="logo-link">
          <SiteyLogo class="logo" />
        </RouterLink>
      </div>

      <div class="nav-section">
        <RouterLink to="/projects" class="nav-item" active-class="active">
          <span class="icon">▦</span> Projects
        </RouterLink>
        <RouterLink to="/domains" class="nav-item" active-class="active">
          <span class="icon">◈</span> Domains
        </RouterLink>
        <RouterLink to="/integrations" class="nav-item" active-class="active">
          <span class="icon">⑂</span> Integrations
        </RouterLink>
        <RouterLink to="/logs" class="nav-item" active-class="active">
          <span class="icon">≡</span> Logs
        </RouterLink>
        <RouterLink to="/settings" class="nav-item" active-class="active">
          <span class="icon">⚙</span> Settings
        </RouterLink>
      </div>

      <div class="sidebar-footer">
        <span class="user-email">{{ auth.user?.email }}</span>
        <button class="logout-btn" @click="auth.logout(); router.push('/login')">
          Logout
        </button>
      </div>
    </nav>

    <main class="content">
      <slot />
    </main>
  </div>
</template>

<script setup lang="ts">
import { watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import SiteyLogo from './SiteyLogo.vue'

const auth = useAuthStore()
const router = useRouter()

// Enforce password change once user data is hydrated (handles page-reload case)
watch(() => auth.needsPasswordChange, (needs) => {
  if (needs) router.push('/change-password')
})
</script>

<style scoped>
.layout {
  display: flex;
  min-height: 100vh;
}

.sidebar {
  width: 220px;
  min-width: 220px;
  background: var(--bg-card);
  border-right: 1px solid var(--border-default);
  display: flex;
  flex-direction: column;
  padding: 0;
}

.sidebar-header {
  padding: 1.25rem 1.25rem 1rem;
  border-bottom: 1px solid var(--border-default);
}

.logo-link { text-decoration: none; display: block; }

.logo {
  font-size: var(--font-large);
  font-weight: 700;
  color: var(--brand);
  letter-spacing: -0.03em;
}

.nav-section {
  flex: 1;
  padding: 0.75rem 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border-radius: 6px;
  color: var(--text-secondary);
  text-decoration: none;
  font-size: var(--font-medium);
  transition: background 0.15s, color 0.15s;
}
.nav-item:hover { background: var(--bg-input); color: var(--text-primary); }
.nav-item.active { background: var(--brand-active-bg); color: var(--brand-active-text); }

.icon { font-size: var(--font-tiny); }

.sidebar-footer {
  padding: 1rem 1.25rem;
  border-top: 1px solid var(--border-default);
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

.content {
  flex: 1;
  overflow-y: auto;
  padding: 2rem;
}
</style>
