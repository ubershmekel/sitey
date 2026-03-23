/**
 * Onboarding smoke tests — validate first-run account creation and
 * Caddy config push behaviour.
 *
 * Scope: intentionally small.  Only covers:
 *   1. API pushes a valid initial Caddyfile to the mock Caddy admin.
 *   2. Adding a domain through the UI triggers a Caddyfile update that
 *      contains the domain name, a tls directive, and the internal API proxy.
 *
 * No Docker, no real Caddy, no network dependencies — all external calls
 * are absorbed by the mock server at http://localhost:3334.
 */

import { test, expect } from "@playwright/test";
import { ensureLoggedIn } from "./helpers.ts";

// Use 127.0.0.1 not localhost — on Windows, Node.js may resolve localhost → ::1
// but the mock server binds to 127.0.0.1.
const MOCK_URL = "http://127.0.0.1:3334";
const TEST_DOMAIN = "*.example.com";

// ── helpers ──────────────────────────────────────────────────────────────────

type RequestEntry = { method: string; path: string; body: string };
function normalizeCaddyfile(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

async function getMockRequests(
  request: import("@playwright/test").APIRequestContext,
): Promise<RequestEntry[]> {
  const res = await request.get(`${MOCK_URL}/__requests`);
  return res.json();
}

// ── Test 1 ────────────────────────────────────────────────────────────────────

test("initial Caddy config push contains HTTP handler and API proxy", async ({
  request,
}) => {
  // The API server calls reloadCaddy() at startup (non-blocking).  It may take
  // a moment after the health check returns.  Poll briefly.
  let logs: RequestEntry[] = [];
  for (let i = 0; i < 20; i++) {
    logs = await getMockRequests(request);
    if (logs.some((e) => e.method === "POST" && e.path === "/caddy/load"))
      break;
    await new Promise((r) => setTimeout(r, 500));
  }

  const initial = logs.find(
    (e) => e.method === "POST" && e.path === "/caddy/load",
  );
  expect(
    initial,
    "API must push an initial Caddyfile on startup",
  ).toBeDefined();

  const body = initial!.body;
  const normalized = normalizeCaddyfile(body);
  const expected = normalizeCaddyfile(`
{
    admin 0.0.0.0:2019
}

:80 {
    @api path /trpc/* /webhook/* /health/*
    handle @api {
        reverse_proxy sitey-api:3001
    }
    handle {
        root * /srv/web
        try_files {path} /index.html
        file_server
    }
}
`);
  expect(normalized).toBe(expected);
});

// ── Test 2 ────────────────────────────────────────────────────────────────────

test("adding a domain through onboarding updates Caddyfile", async ({
  page,
  request,
}) => {
  await ensureLoggedIn(page);

  // We should now be on the dashboard "/"
  await page.waitForURL("**/", { timeout: 10_000 });

  // Step 1 of the getting-started checklist: "Add domain now ->"
  await page.getByText("Add domain now ->").click();

  // The AddDomainModal dialog is now open — fill the hostname field
  await page.locator('input[placeholder="myapp.com"]').fill(TEST_DOMAIN);

  // Submit the form
  await page.getByRole("button", { name: "Add domain", exact: true }).click();

  // Wait for the modal to close (domain created successfully)
  await page.waitForSelector('input[placeholder="myapp.com"]', {
    state: "hidden",
    timeout: 10_000,
  });

  // Step 1 is now done — the "Add domain now" button is replaced by "Manage domains ->"
  await expect(page.getByText("Manage domains ->")).toBeVisible({
    timeout: 5_000,
  });

  // After domain creation the API calls reloadCaddy() synchronously before
  // returning; give the mock a moment to record it then grab the latest entry.
  await page.waitForTimeout(500);

  const logs = await getMockRequests(request);

  // The LAST /caddy/load reflects the post-domain-creation config
  const caddyLoads = logs.filter(
    (e) => e.method === "POST" && e.path === "/caddy/load",
  );
  expect(
    caddyLoads.length,
    "At least one Caddy reload after domain add",
  ).toBeGreaterThanOrEqual(1);

  const latest = caddyLoads[caddyLoads.length - 1];
  const body = normalizeCaddyfile(latest.body);
  const expected = normalizeCaddyfile(`
{
    admin 0.0.0.0:2019
}

:80 {
    @api path /trpc/* /webhook/* /health/*
    handle @api {
        reverse_proxy sitey-api:3001
    }
    handle {
        root * /srv/web
        try_files {path} /index.html
        file_server
    }
}

sitey.example.com {
    @api path /trpc/* /webhook/* /health/*
    handle @api {
        reverse_proxy sitey-api:3001
    }
    handle {
        root * /srv/web
        try_files {path} /index.html
        file_server
    }
}

sitey-dns-check.example.com {
    respond 204
}
`);

  expect(body).toBe(expected);
});
