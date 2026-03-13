import { test, expect } from "@playwright/test";

const BASE_URL = `http://${process.env.SITEY_HOST}`;
const PASSWORD = process.env.SITEY_PASSWORD;
const EMAIL = process.env.SITEY_EMAIL;
const DOMAIN = process.env.SITEY_DOMAIN;

test("setup sitey instance", async ({ page }, testInfo) => {
  if (!process.env.SITEY_HOST || !PASSWORD || !EMAIL || !DOMAIN) {
    throw new Error(
      "Missing env vars: SITEY_HOST, SITEY_PASSWORD, SITEY_EMAIL, SITEY_DOMAIN",
    );
  }

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
  await page.waitForURL(`${BASE_URL}/`);
  await page.screenshot({
    path: testInfo.outputPath("after-login.png"),
    fullPage: true,
  });

  // Add wildcard domain
  await page.getByRole("button", { name: "Add domain now →" }).click();
  await expect(page.getByRole("heading", { name: "Add domain" })).toBeVisible();
  const hostnameInput = page.getByRole("textbox", { name: /Hostname/i });
  await expect(hostnameInput).toBeVisible();
  await hostnameInput.fill(DOMAIN);
  await page.getByRole("button", { name: "Add domain", exact: true }).click();
  await page.screenshot({
    path: testInfo.outputPath("after-add-domain.png"),
    fullPage: true,
  });

  // Open management URL via HTTPS
  const mgmtHost = `sitey.${DOMAIN.replace("*.", "")}`;
  const page1Promise = page.waitForEvent("popup");
  await page.getByRole("link", { name: `Open https://${mgmtHost}` }).click();
  const mgmtPage = await page1Promise;

  // Login again on management domain
  await mgmtPage.getByRole("textbox", { name: "Email" }).fill(EMAIL);
  await mgmtPage.getByRole("textbox", { name: "Password" }).fill(PASSWORD);
  await mgmtPage.getByRole("button", { name: "Sign in" }).click();

  await page.screenshot({
    path: testInfo.outputPath("after-https-login.png"),
    fullPage: true,
  });

  // Verify navigation works
  await mgmtPage.getByRole("link", { name: "Projects" }).click();
  await expect(
    mgmtPage.getByRole("button", { name: "Add project" }),
  ).toBeVisible();
});
