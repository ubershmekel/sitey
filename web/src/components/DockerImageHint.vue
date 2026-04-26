<template>
  <span class="hint"
    >(optional, e.g.
    <template v-for="(img, i) in images" :key="img"
      ><code>{{ img }}</code
      ><template v-if="i < images.length - 1">, </template></template
    >)</span
  >
</template>

<script setup lang="ts">
const images = [
  "node:24-bookworm-slim",
  "oven/bun:1",
  "python:3.12-slim",
  "golang:1.24-alpine",
];
</script>
