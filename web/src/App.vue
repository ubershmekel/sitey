<template>
  <RouterView />
</template>

<script setup lang="ts">
import { onMounted } from "vue";
import { RouterView } from "vue-router";

onMounted(() => {
  const favicon = localStorage.getItem("sitey_favicon");
  if (favicon) {
    const link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    if (link) link.href = `/${favicon}`;
  }
});
</script>
