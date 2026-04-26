<template>
  <div
    v-if="modelValue"
    class="modal-backdrop"
    @click.self="$emit('update:modelValue', false)"
  >
    <form class="modal" @submit.prevent="submitForm">
      <h2>Add route</h2>

      <div v-if="error" class="alert error">{{ error }}</div>

      <label>
        Domain
        <select v-model="form.domainId" required @change="onDomainChange">
          <option value="">Select domain</option>
          <option v-for="d in domains" :key="d.id" :value="d.id">
            {{ d.hostname }}
          </option>
        </select>
      </label>

      <label v-if="isWildcardSelected">
        Subdomain <span class="hint">(e.g. myapp)</span>
        <div class="subdomain-input-wrap">
          <input
            v-model="form.subdomain"
            type="text"
            placeholder="auto"
            class="subdomain-input"
          />
          <span class="subdomain-suffix">.{{ selectedDomainBase }}</span>
        </div>
      </label>

      <label>
        Path prefix <span class="hint">(optional)</span>
        <input v-model="form.pathPrefix" type="text" placeholder="/" />
      </label>

      <label>
        Protocol
        <select v-model="form.httpOnly" :disabled="selectedDomainIsLoopback">
          <option :value="false">HTTPS (default)</option>
          <option :value="true">HTTP only</option>
        </select>
        <span v-if="selectedDomainIsLoopback" class="hint">
          localhost routes are always HTTP-only.
        </span>
      </label>

      <div class="modal-actions">
        <button
          type="button"
          class="btn-ghost"
          @click="$emit('update:modelValue', false)"
        >
          Cancel
        </button>
        <button
          type="submit"
          class="btn-primary"
          :disabled="saving || !form.domainId"
        >
          {{ saving ? "Saving..." : "Add route" }}
        </button>
      </div>
    </form>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";

type DomainOption = { id: number; hostname: string };
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    domains: DomainOption[];
    saving?: boolean;
    error?: string;
    defaultDomainId?: number | null;
  }>(),
  {
    saving: false,
    error: "",
    defaultDomainId: null,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  submit: [
    {
      domainId: number;
      domainHostname: string;
      pathPrefix: string;
      subdomain: string;
      httpOnly: boolean;
    },
  ];
}>();

const form = ref({
  domainId: null as number | null,
  pathPrefix: "",
  subdomain: "",
  httpOnly: false,
});

const selectedDomain = computed(() =>
  props.domains.find((d) => d.id === form.value.domainId),
);

const isWildcardSelected = computed(
  () => selectedDomain.value?.hostname.startsWith("*.") ?? false,
);

const selectedDomainIsLoopback = computed(() =>
  selectedDomain.value
    ? LOOPBACK_HOSTS.has(selectedDomain.value.hostname)
    : false,
);

const selectedDomainBase = computed(() => {
  if (!selectedDomain.value?.hostname.startsWith("*.")) return "";
  return selectedDomain.value.hostname.slice(2);
});

function resetForm() {
  const preferredDomainId =
    props.defaultDomainId ??
    (props.domains.length === 1 ? props.domains[0].id : null);
  const preferredDomain = props.domains.find((d) => d.id === preferredDomainId);
  form.value = {
    domainId: preferredDomainId,
    pathPrefix: "",
    subdomain: "",
    httpOnly: preferredDomain?.hostname === "localhost",
  };
}

function onDomainChange() {
  form.value.subdomain = "";
  if (selectedDomainIsLoopback.value) form.value.httpOnly = true;
}

function submitForm() {
  if (!form.value.domainId || !selectedDomain.value) return;
  emit("submit", {
    domainId: form.value.domainId,
    domainHostname: selectedDomain.value.hostname,
    pathPrefix: form.value.pathPrefix,
    subdomain: form.value.subdomain.trim().toLowerCase(),
    httpOnly: form.value.httpOnly,
  });
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) resetForm();
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
  width: 440px;
  max-width: calc(100vw - 2rem);
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

label {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.subdomain-input-wrap {
  display: flex;
  align-items: center;
  background: var(--bg-input);
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  overflow: hidden;
  transition: border-color 0.15s;
}

.subdomain-input-wrap:focus-within {
  border-color: var(--brand);
}

.subdomain-input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  border-radius: 0;
  padding: 0.6rem 0.4rem 0.6rem 0.75rem;
}

.subdomain-input:focus {
  border-color: transparent;
}

.subdomain-suffix {
  font-size: var(--font-tiny);
  padding: 0 0.6rem 0 0;
  white-space: nowrap;
  font-family: monospace;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  margin-top: 0.25rem;
}

.alert.error {
  background: var(--status-err-bg);
  border: 1px solid var(--status-err-border);
  color: var(--status-err-text);
  border-radius: 6px;
  padding: 0.6rem 0.75rem;
}
</style>
