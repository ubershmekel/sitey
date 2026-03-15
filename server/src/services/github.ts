/**
 * Shared GitHub App helpers — JWT signing, token generation, API calls.
 * Used by both the GitHub router and the git/deployment services.
 */

import jwt from "jsonwebtoken";
import { db } from "../lib/db.js";

const GITHUB_API_BASE = "https://api.github.com";

export const GITHUB_CONFIG_KEYS = {
  APP_ID: "github_app_id",
  PRIVATE_KEY: "github_app_private_key",
  WEBHOOK_SECRET: "github_app_webhook_secret",
  APP_SLUG: "github_app_slug",
} as const;

export async function getConfig(key: string) {
  const row = await db.systemConfig.findUnique({ where: { key } });
  return row?.value ?? null;
}

export async function setConfig(key: string, value: string) {
  return db.systemConfig.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

export function toPem(key: string) {
  return key.includes("\\n") ? key.replace(/\\n/g, "\n") : key;
}

export function createAppJwt(appId: string, privateKey: string) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iat: now - 60, exp: now + 9 * 60, iss: appId },
    toPem(privateKey),
    { algorithm: "RS256" },
  );
}

export async function githubFetch(path: string, init?: RequestInit) {
  return fetch(`${GITHUB_API_BASE}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.headers ?? {}),
    },
  });
}

/**
 * Generate a short-lived installation access token for a given repo.
 * Uses GET /repos/{owner}/{repo}/installation to find the installation,
 * then POST /app/installations/{id}/access_tokens to mint a token.
 *
 * Returns null if the GitHub App is not configured or the repo has no installation.
 */
export async function getInstallationToken(
  repoOwner: string,
  repoName: string,
): Promise<string | null> {
  const appId = await getConfig(GITHUB_CONFIG_KEYS.APP_ID);
  const privateKey = await getConfig(GITHUB_CONFIG_KEYS.PRIVATE_KEY);
  if (!appId || !privateKey) return null;

  const appJwt = createAppJwt(appId, privateKey);

  // Find the installation that has access to this repo
  const installRes = await githubFetch(
    `/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}/installation`,
    { headers: { Authorization: `Bearer ${appJwt}` } },
  );
  if (!installRes.ok) return null;

  const installData = (await installRes.json()) as { id: number };

  // Mint an access token scoped to this installation
  const tokenRes = await githubFetch(
    `/app/installations/${installData.id}/access_tokens`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${appJwt}` },
    },
  );
  if (!tokenRes.ok) return null;

  const tokenData = (await tokenRes.json()) as { token: string };
  return tokenData.token;
}
