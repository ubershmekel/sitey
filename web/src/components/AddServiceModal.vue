<template>
  <div v-if="modelValue" class="modal-backdrop" @click.self="close">
    <form class="modal" @submit.prevent="addService">
      <h2>{{ title }}</h2>

      <div v-if="addError" class="alert error">{{ addError }}</div>

      <label>
        GitHub repository
        <input
          v-model="form.githubUrl"
          type="text"
          required
          list="repo-list"
          placeholder="owner/repo or https://github.com/owner/repo"
          @input="parseGithubUrl"
          @blur="parseGithubUrl"
        />
        <datalist id="repo-list">
          <option
            v-for="repo in appRepos"
            :key="repo.id"
            :value="repo.fullName"
          />
        </datalist>
        <span v-if="reposLoading" class="hint"
          >Loading repos from GitHub App...</span
        >
        <span v-else-if="repoLoadError" class="hint">{{ repoLoadError }}</span>
        <span v-else-if="reposConfigured && appRepos.length > 0" class="hint">
          Autocomplete powered by your GitHub App repositories.
        </span>
        <span
          v-else-if="reposConfigured && repoInstallations === 0"
          class="hint"
        >
          GitHub App configured but not installed yet.
          <a
            v-if="repoInstallUrl"
            :href="repoInstallUrl"
            target="_blank"
            rel="noopener"
            >Install app</a
          >.
        </span>
      </label>

      <label>
        Service name <span class="hint">(lowercase, hyphens only)</span>
        <input
          v-model="form.name"
          type="text"
          required
          placeholder="my-app"
          pattern="[a-z0-9-]+"
        />
      </label>

      <label>
        Branch
        <input
          v-model="form.branch"
          type="text"
          placeholder="main"
          list="branch-list"
        />
        <datalist id="branch-list">
          <option v-for="b in branches" :key="b" :value="b" />
        </datalist>
      </label>

      <ServiceSettingsFields v-model="settings" />

      <label v-if="allowDomainSelection">
        Domain
        <span class="hint">(optional — can add routes after creation)</span>
        <select v-model="form.domainId">
          <option value="">No domain yet</option>
          <option v-for="d in domains" :key="d.id" :value="d.id">
            {{ d.hostname }}
          </option>
        </select>
      </label>

      <div class="modal-actions">
        <button type="button" class="btn-ghost" @click="close">Cancel</button>
        <button type="submit" class="btn-primary" :disabled="adding">
          {{ adding ? "Creating..." : "Create service" }}
        </button>
      </div>
    </form>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { trpc } from "../trpc";
import ServiceSettingsFields, {
  type ServiceSettings,
} from "./ServiceSettingsFields.vue";

type AppRepo = Awaited<
  ReturnType<typeof trpc.github.listAppRepos.query>
>["repos"][number];
type DomainOption = { id: number; hostname: string };

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    title?: string;
    domains?: DomainOption[];
    fixedDomainId?: number | null;
  }>(),
  {
    title: "New service",
    domains: () => [],
    fixedDomainId: null,
  },
);

const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
  (e: "created", serviceId: number): void;
}>();

const adding = ref(false);
const addError = ref("");
const branches = ref<string[]>([]);
const appRepos = ref<AppRepo[]>([]);
const reposLoading = ref(false);
const repoLoadError = ref("");
const reposConfigured = ref(false);
const repoInstallations = ref<number>(0);
const repoInstallUrl = ref("");
const inferredServiceName = ref("");

const form = ref(emptyForm());
const settings = ref<ServiceSettings>(defaultSettings());

function defaultSettings(): ServiceSettings {
  return {
    deployType: "server",
    buildCommand: "",
    outputDir: "dist",
    buildImage: "",
    serverRunCommand: "",
    containerPort: 3000,
    dockerfilePath: "",
  };
}

const repoByFullName = computed(() => {
  return new Map(
    appRepos.value.map((repo) => [repo.fullName.toLowerCase(), repo]),
  );
});

const allowDomainSelection = computed(
  () => props.fixedDomainId == null && props.domains.length > 0,
);
const domainById = computed(
  () => new Map(props.domains.map((domain) => [domain.id, domain])),
);

function emptyForm() {
  return {
    name: "",
    githubUrl: "",
    repoOwner: "",
    repoName: "",
    domainId: null as number | null,
    branch: "main",
  };
}

function close() {
  emit("update:modelValue", false);
}

function parseGithubUrl() {
  const val = form.value.githubUrl.trim();
  const match =
    val.match(/(?:github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?$/) ??
    val.match(/^([^/]+)\/([^/]+)$/);
  if (!match) return;

  form.value.repoOwner = match[1];
  form.value.repoName = match[2];
  inferServiceName(match[2]);

  const selected = repoByFullName.value.get(
    `${match[1]}/${match[2]}`.toLowerCase(),
  );
  if (
    selected?.defaultBranch &&
    (!form.value.branch.trim() || form.value.branch === "main")
  ) {
    form.value.branch = selected.defaultBranch;
  }
  fetchBranches();
}

function inferServiceName(repoName: string) {
  const inferred = repoName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");

  if (!inferred) return;
  if (
    !form.value.name.trim() ||
    form.value.name === inferredServiceName.value
  ) {
    form.value.name = inferred;
  }
  inferredServiceName.value = inferred;
}

async function fetchBranches() {
  const { repoOwner, repoName } = form.value;
  if (!repoOwner || !repoName) return;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repoOwner}/${repoName}/branches?per_page=50`,
    );
    if (!res.ok) return;
    const data = (await res.json()) as { name: string }[];
    branches.value = data.map((b) => b.name);
  } catch {
    // branch autocomplete is optional
  }
}

async function loadRepoSuggestions() {
  reposLoading.value = true;
  repoLoadError.value = "";
  try {
    const res = await trpc.github.listAppRepos.query();
    appRepos.value = res.repos;
    reposConfigured.value = res.configured;
    repoInstallations.value = Array.isArray(res.installations)
      ? res.installations.length
      : 0;
    repoInstallUrl.value = res.app.installUrl ?? "";
  } catch {
    appRepos.value = [];
    reposConfigured.value = false;
    repoInstallations.value = 0;
    repoInstallUrl.value = "";
    repoLoadError.value = "Could not load GitHub App repositories.";
  } finally {
    reposLoading.value = false;
  }
}

async function addService() {
  addError.value = "";
  adding.value = true;
  parseGithubUrl();

  try {
    const s = settings.value;
    const isStatic = s.deployType === "static";
    const isDockerfile = s.deployType === "dockerfile";
    const deployMode = isStatic ? "static" : "server";
    const buildMode = isDockerfile ? "dockerfile" : "auto";
    const outputDir = isStatic ? s.outputDir.trim() || "dist" : "";
    let buildImage = "";
    let serverRunCommand = "";
    let dockerfilePath = "";

    if (isDockerfile) {
      dockerfilePath = s.dockerfilePath.trim();
    } else {
      buildImage = s.buildImage.trim();
      if (!isStatic) {
        serverRunCommand = s.serverRunCommand.trim();
      }
    }

    const created = await trpc.services.create.mutate({
      name: form.value.name.trim(),
      repoOwner: form.value.repoOwner.trim(),
      repoName: form.value.repoName.trim(),
      branch: form.value.branch.trim() || "main",
      githubMode: reposConfigured.value ? "app" : "webhook",
      deployMode,
      buildCommand: s.buildCommand.trim(),
      outputDir,
      buildImage,
      serverRunCommand,
      buildMode,
      dockerfilePath,
      containerPort: s.containerPort,
    });

    const routeDomainId = props.fixedDomainId ?? form.value.domainId;
    if (routeDomainId) {
      const selectedDomain = domainById.value.get(routeDomainId);
      await trpc.services.addRoute.mutate({
        serviceId: created.id,
        domainId: routeDomainId,
        httpOnly: selectedDomain?.hostname === "localhost",
      });
    }

    emit("created", created.id);
    emit("update:modelValue", false);
  } catch (e: unknown) {
    addError.value =
      (e as { message?: string })?.message ?? "Failed to create service";
  } finally {
    adding.value = false;
  }
}

watch(
  () => props.modelValue,
  async (visible) => {
    if (!visible) {
      form.value = emptyForm();
      settings.value = defaultSettings();
      branches.value = [];
      inferredServiceName.value = "";
      addError.value = "";
      return;
    }

    if (allowDomainSelection.value && props.domains.length === 1) {
      form.value.domainId = props.domains[0].id;
    }
    await loadRepoSuggestions();
  },
);
</script>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.modal {
  background: var(--bg-card);
  border: 1px solid var(--border-default);
  border-radius: 12px;
  padding: 2rem;
  width: 520px;
  max-width: calc(100vw - 2rem);
  max-height: 90vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.modal h2 {
  font-weight: 600;
}

label {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.hint a {
  color: var(--brand);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  margin-top: 0.5rem;
}

.alert.error {
  background: var(--status-err-bg);
  border: 1px solid var(--status-err-border);
  color: var(--status-err-text);
  border-radius: 6px;
  padding: 0.6rem 0.75rem;
}
</style>
