import { defineConfig } from "@playwright/test";

export default defineConfig({
  timeout: 60_000,
  use: {
    ignoreHTTPSErrors: false,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
});
