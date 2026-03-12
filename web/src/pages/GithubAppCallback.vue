<template>
  <Layout>
    <div class="callback-wrap">
      <div v-if="status === 'loading'" class="msg">Completing GitHub App setup…</div>
      <div v-else-if="status === 'error'" class="msg error">
        <div class="msg-title">Setup failed</div>
        <div class="msg-detail">{{ errorMsg }}</div>
        <RouterLink to="/integrations" class="btn-link">Back to Settings</RouterLink>
      </div>
    </div>
  </Layout>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import Layout from '../components/Layout.vue'
import { trpc } from '../trpc'

const router = useRouter()
const status = ref<'loading' | 'error'>('loading')
const errorMsg = ref('')

onMounted(async () => {
  const params = new URLSearchParams(window.location.search)
  const code = params.get('code')
  if (!code) {
    status.value = 'error'
    errorMsg.value = 'No code returned from GitHub.'
    return
  }
  try {
    await trpc.github.exchangeManifestCode.mutate({ code })
    router.replace('/integrations?app_created=1')
  } catch (e: unknown) {
    status.value = 'error'
    errorMsg.value = (e as { message?: string })?.message ?? 'Unknown error'
  }
})
</script>

<style scoped>
.callback-wrap {
  display: flex; align-items: center; justify-content: center;
  padding: 6rem 2rem;
}
.msg {
  text-align: center; color: #888;
}
.msg.error { color: #ff7070; }
.msg-title { font-size: var(--font-large); font-weight: 600; margin-bottom: 0.5rem; }
.msg-detail { font-size: var(--font-tiny); color: #cc4444; margin-bottom: 1.5rem; }
.btn-link {
  color: #7c6cfc; text-decoration: none;
}
.btn-link:hover { text-decoration: underline; }
</style>
