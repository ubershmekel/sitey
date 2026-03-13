import { test, expect } from "@playwright/test";

const BASE_URL = `http://${process.env.SITEY_HOST}`;
const PASSWORD = process.env.SITEY_PASSWORD;
const EMAIL = process.env.SITEY_EMAIL;
const DOMAIN = process.env.SITEY_DOMAIN;

test("setup sitey instance", async ({ page }) => {
  // Login with bootstrap password
  await page.goto(`${BASE_URL}/login`);
  await page.getByRole("textbox", { name: "Email" }).fill(EMAIL);
  await page.getByRole("textbox", { name: "Password" }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  // Change password (reuse same password to get past mustChangePassword)
  await page.waitForURL("**/change-password");
  await page.getByLabel("Current password").fill(PASSWORD);
  await page.getByRole("textbox", { name: /^New password/ }).fill(PASSWORD);
  await page.getByLabel("Confirm new password").fill(PASSWORD);
  await page.getByRole("button", { name: "Set new password" }).click();

  // Add wildcard domain
  await page.getByRole("button", { name: "Add domain now →" }).click();
  await page.getByLabel(/^Hostname/).fill(DOMAIN);
  await page.getByRole("button", { name: "Add domain", exact: true }).click();

  // Open management URL via HTTPS
  const mgmtHost = `sitey.${DOMAIN.replace("*.", "")}`;
  const page1Promise = page.waitForEvent("popup");
  await page.getByRole("link", { name: `Open https://${mgmtHost}` }).click();
  const mgmtPage = await page1Promise;

  // Login again on management domain
  await mgmtPage.getByRole("textbox", { name: "Email" }).fill(EMAIL);
  await mgmtPage.getByRole("textbox", { name: "Password" }).fill(PASSWORD);
  await mgmtPage.getByRole("button", { name: "Sign in" }).click();

  // Verify navigation works
  await mgmtPage.getByRole("link", { name: "Projects" }).click();
  await expect(
    mgmtPage.getByRole("button", { name: "Add project" }),
  ).toBeVisible();

  await mgmtPage.getByRole("link", { name: "Domains" }).click();
  await expect(
    mgmtPage.getByRole("button", { name: "+ Add domain" }),
  ).toBeVisible();

  await mgmtPage.getByRole("link", { name: "Integrations" }).click();
  await mgmtPage.getByRole("link", { name: "Logs" }).click();
  await mgmtPage.getByRole("link", { name: "Settings" }).click();
});
