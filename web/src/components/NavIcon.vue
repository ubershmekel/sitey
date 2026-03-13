<template>
  <svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <template v-if="name === 'home'">
      <polyline points="1.5,8.5 8,2 14.5,8.5"/>
      <path d="M3.5 7.8V14h3.3v-3.5h2.4V14h3.3V7.8"/>
    </template>
    <template v-else-if="name === 'projects'">
      <rect x="2" y="2" width="5" height="5" rx="1"/>
      <rect x="9" y="2" width="5" height="5" rx="1"/>
      <rect x="2" y="9" width="5" height="5" rx="1"/>
      <rect x="9" y="9" width="5" height="5" rx="1"/>
    </template>
    <template v-else-if="name === 'domains'">
      <circle cx="8" cy="8" r="6"/>
      <path d="M8 2c-2 2.5-2 9.5 0 12M8 2c2 2.5 2 9.5 0 12"/>
      <line x1="2" y1="8" x2="14" y2="8"/>
    </template>
    <template v-else-if="name === 'integrations'">
      <path d="M6.5 9.5a3.5 3.5 0 0 0 4.95 0l1.5-1.5a3.5 3.5 0 0 0-4.95-4.95l-.75.75"/>
      <path d="M9.5 6.5a3.5 3.5 0 0 0-4.95 0l-1.5 1.5a3.5 3.5 0 0 0 4.95 4.95l.75-.75"/>
    </template>
    <template v-else-if="name === 'logs'">
      <line x1="2" y1="4" x2="14" y2="4"/>
      <line x1="2" y1="8" x2="14" y2="8"/>
      <line x1="2" y1="12" x2="10" y2="12"/>
    </template>
    <template v-else-if="name === 'settings'">
      <circle cx="8" cy="8" r="2.5"/>
      <path d="M8 1.5V3M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1"/>
    </template>
  </svg>
</template>

<script setup lang="ts">
defineProps<{ name: 'home' | 'projects' | 'domains' | 'integrations' | 'logs' | 'settings' }>()
</script>

<style scoped>
.icon { width: 1em; height: 1em; flex-shrink: 0; }
</style>
