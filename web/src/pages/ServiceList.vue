<template>
  <Layout>
    <div class="page-header">
      <h1>Services</h1>
      <button class="btn-primary" @click="showAdd = true">+ New service</button>
    </div>

    <div v-if="loading" class="state-msg">Loading...</div>
    <div v-else-if="error" class="alert error">{{ error }}</div>

    <template v-else>
      <div v-if="userServices.length > 0" class="service-grid">
        <RouterLink
          v-for="s in userServices"
          :key="s.id"
          :to="`/services/${s.id}`"
          class="service-card"
        >
          <div class="service-name">{{ s.name }}</div>
          <div class="service-meta">
            <span v-if="!s.active" class="status status-inactive"
              >inactive</span
            >
            <span v-else :class="`status status-${s.status}`">{{
              s.status
            }}</span>
            <span class="deploy-mode">{{ s.deployMode }}</span>
          </div>
          <div class="service-routes">
            <span v-if="s.routes.length === 0" class="no-routes"
              >no routes</span
            >
            <span v-for="r in s.routes" :key="r.id" class="route-tag">
              {{ routeLabel(r) }}
            </span>
          </div>
          <div class="service-repo">
            {{ s.repo.repoOwner }}/{{ s.repo.repoName }}
          </div>
        </RouterLink>
      </div>
      <div v-else class="empty-state">
        <div class="empty-icon"><NavIcon name="services" /></div>
        <p>No services yet.</p>
        <p class="hint">Create one to deploy your first app.</p>
        <button class="btn-primary" @click="showAdd = true">Add service</button>
      </div>
    </template>

    <AddServiceModal
      v-model="showAdd"
      title="New service"
      :domains="domains"
      @created="handleServiceCreated"
    />
  </Layout>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import AddServiceModal from "../components/AddServiceModal.vue";
import Layout from "../components/Layout.vue";
import NavIcon from "../components/NavIcon.vue";
import { trpc } from "../trpc";

type Service = Awaited<ReturnType<typeof trpc.services.list.query>>[number];
type Route = Service["routes"][number];
type Domain = Awaited<ReturnType<typeof trpc.domains.list.query>>[number];

const services = ref<Service[]>([]);
const loading = ref(true);
const error = ref("");
const showAdd = ref(false);
const domains = ref<Pick<Domain, "id" | "hostname">[]>([]);

const userServices = computed(() => services.value.filter((s) => !s.protected));

function routeLabel(r: Route): string {
  const host = (() => {
    if (!r.domain?.hostname) return "<server>";
    if (!r.domain.hostname.startsWith("*.")) return r.domain.hostname;
    return r.subdomain
      ? `${r.subdomain}.${r.domain.hostname.slice(2)}`
      : r.domain.hostname;
  })();
  return r.pathPrefix ? `${host}${r.pathPrefix}` : host;
}

async function fetchAll() {
  loading.value = true;
  error.value = "";
  try {
    const [serviceList, domainList] = await Promise.all([
      trpc.services.list.query(),
      trpc.domains.list.query(),
    ]);
    services.value = serviceList;
    domains.value = domainList.map((d) => ({ id: d.id, hostname: d.hostname }));
  } catch (e: unknown) {
    error.value = (e as { message?: string })?.message ?? "Failed to load";
  } finally {
    loading.value = false;
  }
}

async function handleServiceCreated() {
  await fetchAll();
}

onMounted(fetchAll);
</script>

<style scoped>
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 2rem;
}

h1 {
  font-weight: 600;
}

.service-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1rem;
}

.service-card {
  background: var(--bg-card);
  border: 1px solid var(--border-default);
  border-radius: 10px;
  padding: 1.25rem 1.5rem;
  text-decoration: none;
  color: inherit;
  transition:
    border-color 0.15s,
    background 0.15s;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.service-card:hover {
  border-color: var(--brand);
  background: var(--bg-hover);
}

.service-name {
  font-weight: 600;
}

.service-meta {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.deploy-mode {
  font-size: var(--font-tiny);
  background: var(--bg-input);
  border: 1px solid var(--border-strong);
  padding: 0.15rem 0.4rem;
  border-radius: 4px;
}

.service-routes {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.route-tag {
  font-size: var(--font-tiny);
  color: var(--brand);
  background: var(--brand-active-bg);
  border: 1px solid #3a3060;
  padding: 0.15rem 0.45rem;
  border-radius: 4px;
}

.no-routes {
  font-size: var(--font-tiny);
}

.service-repo {
  font-size: var(--font-tiny);
  margin-top: 0.15rem;
}

.status {
  font-size: var(--font-tiny);
  padding: 0.2rem 0.5rem;
  border-radius: 4px;
  font-weight: 500;
}

.status-idle {
  background: var(--status-idle-bg);
  color: var(--status-idle-text);
}

.status-building {
  background: var(--status-queued-bg);
  color: var(--brand);
}

.status-running {
  background: var(--status-ok-bg);
  color: var(--status-ok-text);
}

.status-failed {
  background: var(--status-err-bg);
  color: var(--status-err-text);
}

.status-stopped {
  background: var(--status-warn-bg);
  color: var(--status-warn-text);
}

.status-inactive {
  background: var(--status-warn-bg, #3d2e00);
  color: var(--status-warn-text, #f5a623);
}

.empty-state {
  text-align: center;
  padding: 4rem 2rem;
}

.empty-icon {
  font-size: 2.5rem;
  margin-bottom: 1rem;
}

.hint {
  margin: 0.25rem 0 1.5rem;
}

.alert.error {
  background: var(--status-err-bg);
  border: 1px solid var(--status-err-border);
  color: var(--status-err-text);
  border-radius: 6px;
  padding: 0.6rem 0.75rem;
  margin-bottom: 1rem;
}
</style>
