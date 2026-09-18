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

    <div class="text-option-group">
      <div class="text-option-label">Static routing</div>
      <div class="text-option-row">
        <button
          v-for="option in ROUTING_OPTIONS"
          :key="option.value"
          type="button"
          :class="{ active: modelValue.staticRoutingMode === option.value }"
          @click="update({ staticRoutingMode: option.value })"
        >
          {{ option.label }}
        </button>
      </div>
      <div class="text-option-help">
        <span v-if="modelValue.staticRoutingMode === 'spa'"
          >Serve <code>index.html</code> for unmatched paths. Intended for
          client-side routers such as React Router or Vue Router.</span
        >
        <span v-else-if="modelValue.staticRoutingMode === 'multi-page'"
          >Resolve <code>/about</code> using <code>/about/index.html</code> or
          <code>/about.html</code>. Missing pages return a real 404. If
          <code>404.html</code> exists in the output directory, it is used as
          the custom 404 page.</span
        >
        <span v-else
          >Advanced. Supply Caddy directives for this service's static routing.
          Sitey continues to manage the host, TLS, analytics, and filesystem
          root. Applies without a redeploy.</span
        >
      </div>
    </div>
    <label v-if="modelValue.staticRoutingMode === 'caddy'">
      Caddy directives
      <span class="hint"
        >(what goes inside this service's site block: no hostname block,
        <code>root</code>, or <code>reverse_proxy</code>. Checked by Caddy when
        you save.)</span
      >
      <textarea
        class="caddy-config"
        :value="modelValue.staticCaddyConfig"
        :placeholder="CADDY_PLACEHOLDER"
        rows="10"
        spellcheck="false"
        @input="
          update({
            staticCaddyConfig: ($event.target as HTMLTextAreaElement).value,
          })
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

export type StaticRoutingMode = "spa" | "multi-page" | "caddy";

export interface ServiceSettings {
  deployType: "static" | "server" | "dockerfile";
  buildCommand: string;
  outputDir: string;
  staticRoutingMode: StaticRoutingMode;
  staticCaddyConfig: string;
  buildImage: string;
  serverRunCommand: string;
  containerPort: number;
  dockerfilePath: string;
}

const ROUTING_OPTIONS: { value: StaticRoutingMode; label: string }[] = [
  { value: "spa", label: "Single-page app" },
  { value: "multi-page", label: "Multi-page site" },
  { value: "caddy", label: "Custom Caddy" },
];

const CADDY_PLACEHOLDER = `@legacy path /old/*
redir @legacy /new{uri} 308

header /assets/* Cache-Control "public, max-age=31536000, immutable"

try_files {path} {path}/index.html {path}.html =404
file_server`;

const props = defineProps<{ modelValue: ServiceSettings }>();
const emit = defineEmits<{
  (e: "update:modelValue", v: ServiceSettings): void;
}>();

function update(patch: Partial<ServiceSettings>) {
  emit("update:modelValue", { ...props.modelValue, ...patch });
}
</script>

<style scoped>
.caddy-config {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: pre;
}
</style>
