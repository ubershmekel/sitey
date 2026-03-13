<template>
  <div v-if="modelValue" class="modal-backdrop" @click.self="$emit('update:modelValue', false)">
    <form class="modal" @submit.prevent="addDomain">
      <h2>Add domain</h2>

      <div v-if="addError" class="alert error">{{ addError }}</div>

      <div class="tip">
        <strong>Tip: wildcard subdomain setup</strong><br>
        Point a wildcard DNS A record
        <code>*.yourdomain.com → {{ serverIp || 'your server IP' }}</code>
        <template v-if="serverIp"> is the detected IP address but it might be wrong.</template>
        After this step, every new project automatically gets a
        random subdomain like <code>happy-fox-3k2.yourdomain.com</code> — just like Netlify
        or Vercel — with no extra DNS steps per project.
      </div>

      <label>
        Hostname <span class="hint">(e.g. myapp.com or *.myapp.com)</span>
        <input v-model="newHostname" type="text" required placeholder="myapp.com" @blur="checkDns" />
      </label>
      <div v-if="dnsResult !== null" class="dns-check">
        <span v-if="dnsResult.resolves && !dnsResult.wildcard" class="dns-ok">
          Resolves: {{ dnsResult.addresses.join(', ') }}
        </span>
        <span v-else-if="dnsResult.resolves && dnsResult.wildcard" class="dns-ok">
          Wildcard test resolves ({{ dnsResult.checkedHostname }}): {{ dnsResult.addresses.join(', ') }}
        </span>
        <span v-else-if="!dnsResult.resolves && dnsResult.wildcard" class="dns-fail">
          Wildcard test host {{ dnsResult.checkedHostname }} is not resolving.
        </span>
        <span v-else class="dns-fail">
          DNS not resolving - make sure an A record points to this server
        </span>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-ghost" @click="$emit('update:modelValue', false)">Cancel</button>
        <button type="submit" class="btn-primary" :disabled="adding">
          {{ adding ? 'Adding…' : 'Add domain' }}
        </button>
      </div>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { trpc } from '../trpc'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  created: []
}>()

const serverIp = ref('')
const newHostname = ref('')
const adding = ref(false)
const addError = ref('')
type DnsResult = {
  resolves: boolean
  addresses: string[]
  checkedHostname: string
  wildcard: boolean
} | null
const dnsResult = ref<DnsResult>(null)

watch(() => props.modelValue, async (open) => {
  if (open && !serverIp.value) {
    trpc.system.getServerIp.query().then(r => { serverIp.value = r.ip ?? '' }).catch(() => { })
  }
  if (!open) {
    newHostname.value = ''
    dnsResult.value = null
    addError.value = ''
    adding.value = false
  }
})

async function checkDns() {
  const h = newHostname.value.trim().toLowerCase()
  if (!h) { dnsResult.value = null; return }
  dnsResult.value = await trpc.domains.checkDns.query({ hostname: h })
}

async function addDomain() {
  addError.value = ''
  adding.value = true
  try {
    const hostname = newHostname.value.trim().toLowerCase()
    await trpc.domains.create.mutate({ hostname })
    emit('update:modelValue', false)
    emit('created')
  } catch (e: unknown) {
    addError.value = (e as { message?: string })?.message ?? 'Failed to add domain'
  } finally {
    adding.value = false
  }
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
  z-index: 100;
}

.modal {
  background: var(--bg-card);
  border: 1px solid var(--border-default);
  border-radius: 12px;
  padding: 2rem;
  width: 420px;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.modal h2 {
  font-weight: 600;
}

label {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}


input {
  background: var(--bg-input);
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  padding: 0.6rem 0.75rem;
  outline: none;
  transition: border-color 0.15s;
}

input:focus {
  border-color: var(--brand);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  margin-top: 0.5rem;
}

.btn-ghost {
  background: none;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  padding: 0.6rem 1.25rem;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}

.btn-ghost:hover {
  border-color: var(--text-muted);
}

.dns-check {
  font-size: var(--font-tiny);
  padding: 0.1rem 0;
}

.dns-ok {
  color: var(--status-ok-text);
}

.dns-fail {
  color: var(--status-err-text);
}

.tip {
  background: var(--status-info-bg);
  border: 1px solid var(--status-info-border);
  border-radius: 8px;
  padding: 0.75rem 1rem;
  font-size: var(--font-tiny);
  color: var(--status-info-text);
  line-height: 1.55;
}

.tip strong {
  color: var(--status-info-bright);
}

.tip code {
  background: #1a2a40;
  border-radius: 3px;
  padding: 0.1em 0.35em;
}

.alert.error {
  background: var(--status-err-bg);
  border: 1px solid var(--status-err-border);
  color: var(--status-err-text);
  border-radius: 6px;
  padding: 0.6rem 0.75rem;
}
</style>
