import { createApp } from "vue";
import { createPinia } from "pinia";
import { recoverFromNavigationError, router } from "./router";
import App from "./App.vue";
import "./styles/theme.css";
import "./styles/components.css";

// Vite emits this when a preloaded dynamic module fails; use the same hard-nav
// recovery path as router errors so users are not stuck on a broken SPA transition.
window.addEventListener("vite:preloadError", () => {
  recoverFromNavigationError();
});

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.mount("#app");
