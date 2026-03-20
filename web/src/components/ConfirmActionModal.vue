<template>
  <div v-if="modelValue" class="modal-backdrop" @click.self="cancel">
    <div class="modal">
      <h2>{{ title }}</h2>
      <p class="modal-message">{{ message }}</p>
      <div class="modal-actions">
        <button
          type="button"
          class="btn-ghost"
          :disabled="loading"
          @click="cancel"
        >
          Cancel
        </button>
        <button
          type="button"
          :class="danger ? 'btn-danger' : 'btn-primary'"
          :disabled="loading"
          @click="$emit('confirm')"
        >
          {{ loading ? "Working..." : confirmLabel }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    title: string;
    message: string;
    confirmLabel?: string;
    danger?: boolean;
    loading?: boolean;
  }>(),
  {
    confirmLabel: "Confirm",
    danger: false,
    loading: false,
  },
);

const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
  (e: "confirm"): void;
}>();

function cancel() {
  if (props.loading) return;
  emit("update:modelValue", false);
}
</script>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 110;
}

.modal {
  background: var(--bg-card);
  border: 1px solid var(--border-default);
  border-radius: 12px;
  padding: 1.5rem;
  width: 420px;
  max-width: calc(100vw - 2rem);
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.modal h2 {
  font-size: var(--font-large);
  font-weight: 600;
}

.modal-message {
  margin: 0;
  color: var(--text-secondary);
}

.modal-actions {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.btn-danger {
  background: var(--status-err-bg);
  color: var(--status-err-text);
  border: none;
  border-radius: 6px;
  padding: 0.6rem 1.25rem;
  cursor: pointer;
}

.btn-danger:hover {
  background: #7a2020;
}
</style>
