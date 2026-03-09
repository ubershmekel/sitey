<template>
  <div class="layout">
    <nav class="sidebar">
      <div class="sidebar-header">
        <SiteyLogo class="logo" />
      </div>

      <div class="nav-section">
        <RouterLink to="/" class="nav-item" active-class="active">
          <span class="icon">▦</span> Projects
        </RouterLink>
        <RouterLink to="/domains" class="nav-item" active-class="active">
          <span class="icon">◈</span> Domains
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
  background: #161616;
  border-right: 1px solid #2a2a2a;
  display: flex;
  flex-direction: column;
  padding: 0;
}

.sidebar-header {
  padding: 1.25rem 1.25rem 1rem;
  border-bottom: 1px solid #2a2a2a;
}

.logo {
  font-size: 1.2rem;
  font-weight: 700;
  color: #7c6cfc;
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
  color: #9a9a9a;
  text-decoration: none;
  font-size: 0.9rem;
  transition: background 0.15s, color 0.15s;
}
.nav-item:hover { background: #1f1f1f; color: #e2e2e2; }
.nav-item.active { background: #1e1b3a; color: #a89cff; }

.icon { font-size: 0.85rem; }

.sidebar-footer {
  padding: 1rem 1.25rem;
  border-top: 1px solid #2a2a2a;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.user-email {
  font-size: 0.8rem;
  color: #666;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.logout-btn {
  background: none;
  border: 1px solid #2a2a2a;
  color: #9a9a9a;
  padding: 0.35rem 0.75rem;
  border-radius: 5px;
  cursor: pointer;
  font-size: 0.8rem;
  transition: border-color 0.15s, color 0.15s;
}
.logout-btn:hover { border-color: #555; color: #e2e2e2; }

.content {
  flex: 1;
  overflow-y: auto;
  padding: 2rem;
}
</style>
