import { defineConfig } from "@playwright/test";

export default defineConfig({
  timeout: 180_000,
  use: {
    ignoreHTTPSErrors: false,
    navigationTimeout: 120_000,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
});
