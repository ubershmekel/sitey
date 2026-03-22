import { defineConfig } from "@playwright/test";

export default defineConfig({
  timeout: 180_000,
  use: {
    ignoreHTTPSErrors: false,
    navigationTimeout: 120_000,
    screenshot: "only-on-failure",
    // If you want more data, set trace to "on-more-requests"
    trace: "on-first-retry",
  },
});
