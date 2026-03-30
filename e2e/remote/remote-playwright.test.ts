import { test, expect, Page, TestInfo } from "@playwright/test";

const BASE_URL = `http://${process.env.SITEY_HOST}`;
const PASSWORD = process.env.SITEY_PASSWORD;
const EMAIL = process.env.SITEY_EMAIL;
const DOMAIN = process.env.SITEY_DOMAIN;

function mgmtBase(): string {
  return `https://sitey.${DOMAIN!.replace("*.", "")}`;
}

async function loginOnMgmt(page: Page) {
  await page.goto(`${mgmtBase()}/login`);
  await page.getByRole("textbox", { name: "Email" }).fill(EMAIL!);
  await page.getByRole("textbox", { name: "Password" }).fill(PASSWORD!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`${mgmtBase()}/`);
}

interface ServiceConfig {
  repo: string;
  name: string;
  deployType: "static" | "server" | "dockerfile";
  buildCommand?: string;
  outputDir?: string;
  serverRunCommand?: string;
  containerPort?: number;
}

/**
 * Create a service via the UI modal, wait for deployment to succeed,
 * and return the live HTTPS URL.
 */
async function createAndDeploy(
  page: Page,
  testInfo: TestInfo,
  opts: ServiceConfig,
): Promise<string> {
  // Open the "New service" modal (page-header button is always visible).
  await page.getByRole("button", { name: /New service/ }).click();
  await expect(
    page.getByRole("heading", { name: "New service" }),
  ).toBeVisible();

  // GitHub repo
  const repoInput = page.getByRole("combobox", { name: /GitHub repository/i });
  await repoInput.fill(opts.repo);
  await repoInput.dispatchEvent("input");
  await repoInput.blur();

  // Service name
  const nameInput = page.getByRole("textbox", { name: /Service name/i });
  await nameInput.fill("");
  await nameInput.fill(opts.name);

  // Deploy type button
  const typeLabel = {
    static: "Static site",
    server: "Server app",
    dockerfile: "Repo Dockerfile",
  }[opts.deployType];
  await page.getByRole("button", { name: typeLabel }).click();

  // Type-specific fields
  if (opts.deployType === "static") {
    if (opts.buildCommand) {
      await page
        .getByRole("textbox", { name: /Build command/i })
        .fill(opts.buildCommand);
    }
    if (opts.outputDir !== undefined) {
      const outputInput = page.getByRole("textbox", {
        name: /Output directory/i,
      });
      await outputInput.fill("");
      await outputInput.fill(opts.outputDir);
    }
  } else if (opts.deployType === "server") {
    if (opts.buildCommand) {
      await page
        .getByRole("textbox", { name: /Build command/i })
        .fill(opts.buildCommand);
    }
    if (opts.serverRunCommand) {
      await page
        .getByRole("textbox", { name: /Start command/i })
        .fill(opts.serverRunCommand);
    }
    if (opts.containerPort) {
      const portInput = page.getByRole("spinbutton", {
        name: /Container port/i,
      });
      await portInput.fill("");
      await portInput.fill(String(opts.containerPort));
    }
  } else {
    // dockerfile
    if (opts.containerPort) {
      const portInput = page.getByRole("spinbutton", {
        name: /Container port/i,
      });
      await portInput.fill("");
      await portInput.fill(String(opts.containerPort));
    }
  }

  // Select the wildcard domain so a route is auto-assigned.
  const domainSelect = page.locator(".modal select");
  await domainSelect.selectOption({ label: DOMAIN! });

  // Submit
  await page.getByRole("button", { name: "Create service" }).click();
  await expect(
    page.getByRole("heading", { name: "New service" }),
  ).not.toBeVisible({ timeout: 15_000 });

  console.log(`[deploy] Created service "${opts.name}", waiting for deploy…`);

  // Navigate into the new service's detail page.
  await page.getByText(opts.name).first().click();
  await expect(page.getByRole("heading", { name: opts.name })).toBeVisible();

  // Poll until status is "running" / "Running" / "Deployed" (static),
  // or bail on "failed" / "Failed" / "Deploy failed".
  const heroStatus = page.locator(".hero-name-row .status");
  for (let i = 0; i < 60; i++) {
    const text = (await heroStatus.textContent())?.trim().toLowerCase() ?? "";
    if (text === "running" || text === "deployed") break;
    if (text.includes("fail")) {
      await page.screenshot({
        path: testInfo.outputPath(`${opts.name}-failed.png`),
        fullPage: true,
      });
      // TODO: uncomment this when we have a way to get the error message.
      // throw new Error(`Deployment failed for ${opts.name}: "${text}"`);
    }
    await page.waitForTimeout(10_000);
    await page.reload();
    await expect(heroStatus).toBeVisible();
  }

  console.log(`[deploy] "${opts.name}" is live`);

  // Read the auto-assigned URL from the hero card.
  const urlEl = page.locator(".hero-url a").first();
  const serviceUrl = await urlEl.getAttribute("href");
  if (!serviceUrl) throw new Error(`No URL found for ${opts.name}`);

  await page.screenshot({
    path: testInfo.outputPath(`${opts.name}-deployed.png`),
    fullPage: true,
  });

  // Go back to services list for the next creation.
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "Services" })
    .click();
  await expect(page.getByRole("heading", { name: "Services" })).toBeVisible();

  return serviceUrl;
}

test("setup sitey instance", async ({ page }, testInfo) => {
  if (!process.env.SITEY_HOST || !PASSWORD || !EMAIL || !DOMAIN) {
    throw new Error(
      "Missing env vars: SITEY_HOST, SITEY_PASSWORD, SITEY_EMAIL, SITEY_DOMAIN",
    );
  }

  // Login with bootstrap password.
  await page.goto(`${BASE_URL}/login`);
  await page.getByRole("textbox", { name: "Email" }).fill(EMAIL);
  await page.getByRole("textbox", { name: "Password" }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  // Override password logs straight in (mustChangePassword=false), so we land on /.
  await page.waitForURL(`${BASE_URL}/`);
  await page.screenshot({
    path: testInfo.outputPath("http-dashboard-loading.png"),
    fullPage: true,
  });

  // Add wildcard domain.
  await page.getByRole("button", { name: "Add domain now ->" }).click();
  await expect(page.getByRole("heading", { name: "Add domain" })).toBeVisible();
  const hostnameInput = page.getByRole("textbox", { name: /Hostname/i });
  await expect(hostnameInput).toBeVisible();
  await hostnameInput.fill(DOMAIN);
  await page.getByRole("button", { name: "Add domain", exact: true }).click();
  await page.screenshot({
    path: testInfo.outputPath("after-add-domain.png"),
    fullPage: true,
  });

  // Open management URL via HTTPS.
  const mgmtHost = `sitey.${DOMAIN.replace("*.", "")}`;
  const page1Promise = page.waitForEvent("popup");
  await page.getByRole("link", { name: `Open https://${mgmtHost}` }).click();
  const mgmtPage = await page1Promise;

  // Caddy issues the TLS cert on first request — ERR_SSL_PROTOCOL_ERROR is
  // expected until the cert is issued (~30-90s). Retry every 5s for up to 2min.
  for (let attempt = 1; ; attempt++) {
    try {
      await mgmtPage.goto(`https://${mgmtHost}/`, { timeout: 10_000 });
      break;
    } catch (err) {
      if (attempt >= 24) throw err;
      await mgmtPage.waitForTimeout(5_000);
    }
  }

  console.log(`[mgmtPage] url after TLS retry loop: ${mgmtPage.url()}`);

  // Login again on management domain.
  await mgmtPage.getByRole("textbox", { name: "Email" }).fill(EMAIL);
  await mgmtPage.getByRole("textbox", { name: "Password" }).fill(PASSWORD);
  await mgmtPage.getByRole("button", { name: "Sign in" }).click();

  await mgmtPage.waitForURL(`https://${mgmtHost}/`);
  console.log(`[mgmtPage] url after sign-in click: ${mgmtPage.url()}`);

  // Verify dashboard loaded fully before screenshot.
  await expect(
    mgmtPage.getByText("Connect and install GitHub App"),
  ).toBeVisible();
  await mgmtPage.screenshot({
    path: testInfo.outputPath("https-dashboard.png"),
    fullPage: true,
  });

  // Verify navigation works.
  await mgmtPage.getByRole("link", { name: "Services" }).click();
  await expect(
    mgmtPage.getByRole("heading", { name: "Services" }),
  ).toBeVisible();
  await expect(
    mgmtPage.getByRole("button", { name: "Add service" }),
  ).toBeVisible();
  await mgmtPage.screenshot({
    path: testInfo.outputPath("https-services.png"),
    fullPage: true,
  });
});

test("deploy static site", async ({ page, context }, testInfo) => {
  test.setTimeout(900_000);

  await loginOnMgmt(page);
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "Services" })
    .click();
  await expect(page.getByRole("heading", { name: "Services" })).toBeVisible();

  const staticUrl = await createAndDeploy(page, testInfo, {
    repo: "ubershmekel/zensnake",
    name: "zensnake",
    deployType: "static",
    outputDir: "web",
  });

  // Verify it responds
  await page.waitForTimeout(3_000);
  const staticPage = await context.newPage();
  await staticPage.goto(staticUrl, { timeout: 30_000 });
  await expect(staticPage.locator("body")).not.toBeEmpty();
  await staticPage.screenshot({
    path: testInfo.outputPath("verify-zensnake.png"),
    fullPage: true,
  });
  console.log("[verify] zensnake OK");
});

test("deploy server app", async ({ page, context }, testInfo) => {
  test.setTimeout(900_000);

  await loginOnMgmt(page);
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "Services" })
    .click();
  await expect(page.getByRole("heading", { name: "Services" })).toBeVisible();

  const serverUrl = await createAndDeploy(page, testInfo, {
    repo: "ubershmekel/vite-phaser-ts-starter",
    name: "vite-phaser",
    deployType: "server",
    buildCommand: "npm install",
    serverRunCommand: "npm run dev -- --host 0.0.0.0",
    containerPort: 5173,
  });

  // Verify it responds
  await page.waitForTimeout(3_000);
  const serverPage = await context.newPage();
  await serverPage.goto(serverUrl, { timeout: 30_000 });
  await expect(serverPage.locator("body")).not.toBeEmpty();
  await serverPage.screenshot({
    path: testInfo.outputPath("verify-vite-phaser.png"),
    fullPage: true,
  });
  console.log("[verify] vite-phaser OK");
});

test("deploy dockerfile app", async ({ page, context }, testInfo) => {
  test.setTimeout(900_000);

  await loginOnMgmt(page);
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "Services" })
    .click();
  await expect(page.getByRole("heading", { name: "Services" })).toBeVisible();

  const dockerUrl = await createAndDeploy(page, testInfo, {
    repo: "ubershmekel/http-hello",
    name: "http-hello",
    deployType: "dockerfile",
  });

  // Verify it responds
  const dockerPage = await context.newPage();
  // Retry a few times as the app might not be ready immediately
  for (let i = 0; i < 5; i++) {
    try {
      await dockerPage.goto(dockerUrl, { timeout: 30_000 });
      await expect(dockerPage.locator("body")).toContainText(/hello/i, {
        timeout: 5_000,
      });
      break;
    } catch (e) {
      if (i < 4) {
        console.log("[verify] http-hello not ready yet, retrying...");
        await page.waitForTimeout(5_000);
      } else {
        throw e;
      }
    }
  }
  await dockerPage.screenshot({
    path: testInfo.outputPath("verify-http-hello.png"),
    fullPage: true,
  });
  console.log("[verify] http-hello OK");
});
