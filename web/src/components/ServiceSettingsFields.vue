<template>
  <div class="text-option-group">
    <div class="text-option-label">Deploy type</div>
    <div class="text-option-row">
      <button
        type="button"
        :class="{ active: modelValue.deployType === 'static' }"
        @click="update({ deployType: 'static' })"
      >
        Static site
      </button>
      <button
        type="button"
        :class="{ active: modelValue.deployType === 'server' }"
        @click="update({ deployType: 'server' })"
      >
        Server app
      </button>
      <button
        type="button"
        :class="{ active: modelValue.deployType === 'dockerfile' }"
        @click="update({ deployType: 'dockerfile' })"
      >
        Dockerfile
      </button>
    </div>
    <div class="text-option-help">
      <span v-if="modelValue.deployType === 'static'"
        >Build your site and serve the output as static files via Caddy.</span
      >
      <span v-else-if="modelValue.deployType === 'server'"
        >Sitey generates a Dockerfile from your run command and runs it in a
        container.</span
      >
      <span v-else
        >Use your own <code>Dockerfile</code> from the repository.</span
      >
    </div>
  </div>

  <template v-if="modelValue.deployType === 'static'">
    <label>
      Build command
      <span class="hint"
        >(optional, newlines are replaced with &amp;&amp;)</span
      >
      <textarea
        :value="modelValue.buildCommand"
        placeholder="npm run install && npm run build"
        rows="3"
        @input="
          update({ buildCommand: ($event.target as HTMLTextAreaElement).value })
        "
      />
    </label>
    <label>
      Output directory <span class="hint">(relative to repo root)</span>
      <input
        :value="modelValue.outputDir"
        type="text"
        placeholder="dist"
        @input="
          update({ outputDir: ($event.target as HTMLInputElement).value })
        "
      />
    </label>
    <label>
      Docker image
      <DockerImageHint />
      <input
        :value="modelValue.buildImage"
        type="text"
        placeholder="Leave empty for Node.js 24"
        @input="
          update({ buildImage: ($event.target as HTMLInputElement).value })
        "
      />
    </label>
  </template>

  <template v-else-if="modelValue.deployType === 'server'">
    <label>
      Docker image
      <DockerImageHint />
      <input
        :value="modelValue.buildImage"
        type="text"
        placeholder="Leave empty for Node.js 24"
        @input="
          update({ buildImage: ($event.target as HTMLInputElement).value })
        "
      />
    </label>
    <label>
      Build command
      <span class="hint"
        >(optional, newlines are replaced with &amp;&amp;)</span
      >
      <textarea
        :value="modelValue.buildCommand"
        placeholder="npm install && npm run build"
        rows="3"
        @input="
          update({ buildCommand: ($event.target as HTMLTextAreaElement).value })
        "
      />
    </label>
    <label>
      Start command <span class="hint">(e.g. node server.js)</span>
      <input
        :value="modelValue.serverRunCommand"
        type="text"
        required
        placeholder="node server.js"
        @input="
          update({
            serverRunCommand: ($event.target as HTMLInputElement).value,
          })
        "
      />
    </label>
    <label>
      Container port
      <span class="hint"
        >(port your app listens on inside the generated container)</span
      >
      <input
        :value="modelValue.containerPort"
        type="number"
        min="1"
        max="65535"
        required
        @input="
          update({
            containerPort: Number(($event.target as HTMLInputElement).value),
          })
        "
      />
    </label>
  </template>

  <template v-else>
    <label>
      Dockerfile path <span class="hint">(relative to repo root)</span>
      <input
        :value="modelValue.dockerfilePath"
        type="text"
        placeholder="Dockerfile"
        @input="
          update({ dockerfilePath: ($event.target as HTMLInputElement).value })
        "
      />
    </label>
    <label>
      Container port
      <span class="hint">(port your app listens on inside the container)</span>
      <input
        :value="modelValue.containerPort"
        type="number"
        min="1"
        max="65535"
        required
        @input="
          update({
            containerPort: Number(($event.target as HTMLInputElement).value),
          })
        "
      />
    </label>
  </template>
</template>

<script setup lang="ts">
import DockerImageHint from "./DockerImageHint.vue";

export interface ServiceSettings {
  deployType: "static" | "server" | "dockerfile";
  buildCommand: string;
  outputDir: string;
  buildImage: string;
  serverRunCommand: string;
  containerPort: number;
  dockerfilePath: string;
}

const props = defineProps<{ modelValue: ServiceSettings }>();
const emit = defineEmits<{
  (e: "update:modelValue", v: ServiceSettings): void;
}>();

function update(patch: Partial<ServiceSettings>) {
  emit("update:modelValue", { ...props.modelValue, ...patch });
}
</script>
