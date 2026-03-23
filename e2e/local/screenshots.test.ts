/**
 * Screenshot tour — captures every page at wide (1280px) and narrow (375px)
 * viewports so layout regressions are immediately visible.
 *
 * Output: e2e/local/screenshots/NN-<label>-<wide|narrow>.png
 * Files are numbered in navigation order so you can flip through them in any
 * image viewer and follow the full user journey.
 *
 * Run standalone:
 *   npx playwright test --config e2e/local/playwright.config.ts screenshots.test.ts
 */

import { test } from "@playwright/test";
import { ensureLoggedIn } from "./helpers.ts";
import { ScreenshotTaker } from "./screenshot-taker.ts";

const TEST_DOMAIN_FOR_DETAIL = "*.example.com";

test("screenshot tour — all pages, wide and narrow", async ({ page }) => {
  const shots = new ScreenshotTaker(page);

  // ── Unauthenticated pages ──────────────────────────────────────────────────
  await shots.goto("/login", "login");

  // ── Log in, then tour authenticated pages ──────────────────────────────────
  await ensureLoggedIn(page);
  await shots.snap("dashboard");

  await shots.goto("/projects", "projects");
  await shots.goto("/domains", "domains");
  await shots.goto("/integrations", "integrations");
  await shots.goto("/logs", "logs");
  await shots.goto("/settings", "settings");
  await shots.goto("/change-password", "change-password");

  // ── Create a domain so we can screenshot the detail page ──────────────────
  await page.goto("/domains");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Add domain" }).click();
  await page.locator('input[placeholder="myapp.com"]').fill(TEST_DOMAIN_FOR_DETAIL);
  await page.getByRole("button", { name: "Add domain", exact: true }).click();
  await page.waitForSelector('input[placeholder="myapp.com"]', {
    state: "hidden",
    timeout: 10_000,
  });

  // Click into the first domain row to reach the detail page
  const firstDomainLink = page.locator(".domain-row a, table a, a[href^='/domains/']").first();
  if (await firstDomainLink.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await firstDomainLink.click();
    await shots.snap("domain-detail");
    await page.goBack();
  }
});
