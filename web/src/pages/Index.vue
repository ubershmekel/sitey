<template>
  <Layout>
    <div class="page-header">
      <h1>Dashboard</h1>
    </div>

    <div v-if="loading" class="state-msg">Loading…</div>
    <div v-else-if="error" class="alert error">{{ error }}</div>

    <template v-else>
      <div class="onboarding" :class="{ complete: allDone }">
        <div class="onboarding-header" @click="allDone ? (expanded = !expanded) : undefined">
          <div class="onboarding-title-row">
            <span v-if="allDone" class="onboarding-check">✓</span>
            <h2 class="onboarding-title">{{ allDone ? 'Setup complete' : 'Getting started' }}</h2>
          </div>
          <button v-if="allDone" class="onboarding-toggle" type="button">
            {{ expanded ? 'Hide' : 'Show steps' }}
          </button>
        </div>

        <div v-if="!allDone || expanded" class="onboarding-steps">
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
            <RouterLink to="/integrations" class="step-action">
              {{ hasGitHubApp ? 'Manage in Integrations' : 'Go to Integrations →' }}
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
      </div>
    </template>
  </Layout>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import Layout from '../components/Layout.vue'
import { trpc } from '../trpc'

const loading = ref(true)
const error = ref('')
const hasDomain = ref(false)
const hasGitHubApp = ref(false)
const hasProject = ref(false)
const expanded = ref(false)

const allDone = computed(() => hasDomain.value && hasGitHubApp.value && hasProject.value)

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
  background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 12px;
  padding: 1.5rem; margin-bottom: 2rem;
  transition: border-color 0.2s;
}
.onboarding.complete {
  border-color: var(--brand);
  background: linear-gradient(135deg, var(--bg-card) 0%, var(--brand-active-bg) 100%);
}

.onboarding-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 0;
}
.onboarding.complete .onboarding-header { cursor: pointer; }

.onboarding-title-row { display: flex; align-items: center; gap: 0.6rem; }

.onboarding-check {
  width: 22px; height: 22px; border-radius: 50%;
  background: var(--status-ok-bg); border: 2px solid var(--status-ok-border);
  display: flex; align-items: center; justify-content: center;
  font-size: 0.72rem; font-weight: 700; color: var(--status-ok-text); flex-shrink: 0;
}

.onboarding-title {
  font-size: 0.95rem; font-weight: 600; color: var(--text-secondary);
  text-transform: uppercase; letter-spacing: 0.05em;
}
.onboarding.complete .onboarding-title { color: var(--brand-active-text); }

.onboarding-toggle {
  background: none; border: 1px solid var(--border-default); border-radius: 5px;
  color: var(--text-muted); font-size: 0.78rem; padding: 0.2rem 0.6rem;
  cursor: pointer; transition: border-color 0.15s, color 0.15s;
}
.onboarding-toggle:hover { border-color: var(--brand); color: var(--brand-active-text); }

.onboarding-steps { margin-top: 1rem; }

.step {
  display: flex; align-items: flex-start; gap: 1rem;
  padding: 1rem 0; border-bottom: 1px solid var(--border-subtle);
}
.step:last-child { border-bottom: none; padding-bottom: 0; }
.step.done { opacity: 0.65; }

.step-check {
  width: 28px; height: 28px; border-radius: 50%;
  background: var(--bg-input); border: 2px solid var(--border-strong);
  display: flex; align-items: center; justify-content: center;
  font-size: 0.78rem; font-weight: 700; color: var(--text-dim); flex-shrink: 0; margin-top: 2px;
}
.step.done .step-check {
  background: var(--status-ok-bg); border-color: var(--status-ok-border); color: var(--status-ok-text);
}

.step-body { flex: 1; }
.step-heading { font-size: 0.95rem; font-weight: 600; color: var(--text-primary); margin-bottom: 0.35rem; }
.step-desc { font-size: 0.82rem; color: var(--text-muted); line-height: 1.55; }
.step-desc code { background: var(--bg-input); border-radius: 3px; padding: 0.1em 0.35em; font-size: 0.9em; color: #9dcfff; }

.step-action {
  font-size: 0.82rem; color: var(--brand); text-decoration: none; white-space: nowrap;
  padding: 0.35rem 0; flex-shrink: 0; align-self: flex-start; margin-top: 2px;
}
.step-action:hover { text-decoration: underline; }

.state-msg { color: var(--text-muted); }
.alert.error { background: var(--status-err-bg); border: 1px solid var(--status-err-border); color: var(--status-err-text); border-radius: 6px; padding: 0.6rem 0.75rem; font-size: 0.85rem; margin-bottom: 1rem; }
</style>
