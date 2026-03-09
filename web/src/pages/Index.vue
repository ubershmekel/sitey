<template>
  <Layout>
    <div class="page-header">
      <h1>Dashboard</h1>
    </div>

    <div v-if="loading" class="state-msg">Loading…</div>
    <div v-else-if="error" class="alert error">{{ error }}</div>

    <template v-else>
      <div class="onboarding">
        <h2 class="onboarding-title">Getting started</h2>

        <!-- Step 1: Domain -->
        <div class="step" :class="{ done: hasDomain }">
          <div class="step-check">{{ hasDomain ? '✓' : '1' }}</div>
          <div class="step-body">
            <div class="step-heading">Set up a domain</div>
            <div class="step-desc">
              Add the domain you own and point its DNS A record to this server's IP.
              For wildcard subdomains, also add a <code>*</code> A record.
            </div>
          </div>
          <RouterLink to="/domains" class="step-action">
            {{ hasDomain ? 'Manage domains' : 'Go to Domains →' }}
          </RouterLink>
        </div>

        <!-- Step 2: GitHub App -->
        <div class="step" :class="{ done: hasGitHubApp }">
          <div class="step-check">{{ hasGitHubApp ? '✓' : '2' }}</div>
          <div class="step-body">
            <div class="step-heading">Connect GitHub</div>
            <div class="step-desc">
              Create a GitHub App so Sitey can clone your repos and receive push webhooks.
              Go to Settings and click <strong>Create GitHub App automatically</strong> — Sitey will
              pre-fill everything and create the app in one click.
            </div>
          </div>
          <RouterLink to="/settings" class="step-action">
            {{ hasGitHubApp ? 'Manage in Settings' : 'Go to Settings →' }}
          </RouterLink>
        </div>

        <!-- Step 3: Project -->
        <div class="step" :class="{ done: hasProject }">
          <div class="step-check">{{ hasProject ? '✓' : '3' }}</div>
          <div class="step-body">
            <div class="step-heading">Create your first project</div>
            <div class="step-desc">
              Connect a GitHub repository to a domain and deploy it.
            </div>
          </div>
          <RouterLink to="/projects" class="step-action">
            {{ hasProject ? 'View projects' : 'Create project →' }}
          </RouterLink>
        </div>
      </div>
    </template>
  </Layout>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import Layout from '../components/Layout.vue'
import { trpc } from '../trpc'

const loading = ref(true)
const error = ref('')
const hasDomain = ref(false)
const hasGitHubApp = ref(false)
const hasProject = ref(false)

async function fetchAll() {
  loading.value = true
  error.value = ''
  try {
    const [projectList, domainList, appConfig] = await Promise.all([
      trpc.projects.list.query(),
      trpc.domains.list.query(),
      trpc.github.getAppConfig.query(),
    ])
    hasDomain.value = domainList.length > 0
    hasGitHubApp.value = appConfig.configured
    hasProject.value = projectList.filter(p => !p.protected).length > 0
  } catch (e: unknown) {
    error.value = (e as { message?: string })?.message ?? 'Failed to load'
  } finally {
    loading.value = false
  }
}

onMounted(fetchAll)
</script>

<style scoped>
.page-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 2rem;
}
h1 { font-size: 1.4rem; font-weight: 600; }

.onboarding {
  background: #161616; border: 1px solid #2a2a2a; border-radius: 12px;
  padding: 1.5rem; margin-bottom: 2rem;
}
.onboarding-title { font-size: 0.95rem; font-weight: 600; color: #888; margin-bottom: 1rem; text-transform: uppercase; letter-spacing: 0.05em; }

.step {
  display: flex; align-items: flex-start; gap: 1rem;
  padding: 1rem 0; border-bottom: 1px solid #1e1e1e;
}
.step:last-child { border-bottom: none; padding-bottom: 0; }
.step.done { opacity: 0.45; }

.step-check {
  width: 28px; height: 28px; border-radius: 50%;
  background: #1f1f1f; border: 2px solid #333;
  display: flex; align-items: center; justify-content: center;
  font-size: 0.78rem; font-weight: 700; color: #777; flex-shrink: 0; margin-top: 2px;
}
.step.done .step-check {
  background: #0e2a14; border-color: #2a5a30; color: #40c060;
}

.step-body { flex: 1; }
.step-heading { font-size: 0.95rem; font-weight: 600; color: #e2e2e2; margin-bottom: 0.35rem; }
.step-desc { font-size: 0.82rem; color: #666; line-height: 1.55; }
.step-desc code { background: #1f1f1f; border-radius: 3px; padding: 0.1em 0.35em; font-size: 0.9em; color: #9dcfff; }

.step-action {
  font-size: 0.82rem; color: #7c6cfc; text-decoration: none; white-space: nowrap;
  padding: 0.35rem 0; flex-shrink: 0; align-self: flex-start; margin-top: 2px;
}
.step-action:hover { text-decoration: underline; }

.state-msg { color: #666; }
.alert.error { background: #2d1414; border: 1px solid #5a1a1a; color: #ff7070; border-radius: 6px; padding: 0.6rem 0.75rem; font-size: 0.85rem; margin-bottom: 1rem; }
</style>
