import type { Page } from "@playwright/test";

export const TEST_EMAIL = "admin@sitey-e2e.test";
export const TEST_PASSWORD = "e2e-password-1";

/**
 * Handle the full auth flow from /login:
 *  - First-run wizard (setup): create account.
 *  - Returning user (login): sign in.
 *  - If redirected to /change-password: complete it (defensive only — the
 *    setup wizard always creates accounts with mustChangePassword=false).
 */
export async function ensureLoggedIn(page: Page) {
  await page.goto("/login");
  await page.waitForLoadState("networkidle");

  const url = page.url();

  if (url.includes("/change-password")) {
    await page.fill('input[autocomplete="current-password"]', TEST_PASSWORD);
    await page.fill('input[autocomplete="new-password"]', TEST_PASSWORD + "X");
    await page
      .locator('input[autocomplete="new-password"]')
      .nth(1)
      .fill(TEST_PASSWORD + "X");
    await page.click('button[type="submit"]');
    await page.waitForURL("**/", { timeout: 15_000 });
    return;
  }

  const submitBtn = page.locator('button[type="submit"]');
  await submitBtn.waitFor({ timeout: 10_000 });

  await page.fill('input[type="email"]', TEST_EMAIL);
  await page.fill('input[type="password"]', TEST_PASSWORD);
  await submitBtn.click();

  await page.waitForURL(/\/(change-password)?$/, { timeout: 15_000 });

  if (page.url().includes("/change-password")) {
    await page.fill('input[autocomplete="current-password"]', TEST_PASSWORD);
    const newPw = TEST_PASSWORD + "X";
    await page.locator('input[autocomplete="new-password"]').nth(0).fill(newPw);
    await page.locator('input[autocomplete="new-password"]').nth(1).fill(newPw);
    await page.click('button[type="submit"]');
    await page.waitForURL("**/", { timeout: 15_000 });
  }

  await page.reload();
  await page.waitForLoadState("networkidle");
}
