import { db } from "../lib/db.js";

export const SITEY_PUBLIC_URL_KEY = "sitey_public_url";

const ABSOLUTE_URL_REGEX = /^[a-z][a-z\d+\-.]*:\/\//i;

export type PublicSiteUrlSource = "config" | "wildcard" | "env" | "none";

export type PublicSiteUrlResolution = {
  // Explicitly saved by the user in Settings (stored in SystemConfig). Highest priority.
  configuredUrl: string | null;
  // Inferred from the first wildcard domain with siteySubdomainsEnabled (e.g. sitey.example.com).
  wildcardUrl: string | null;
  // Read from the SITEY_URL environment variable. Lowest priority.
  envUrl: string | null;
  // The URL actually in use — whichever of the three sources won, or null if none are usable.
  effectiveUrl: string | null;
  // Which source produced effectiveUrl.
  source: PublicSiteUrlSource;
};

export function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
}

export function normalizeSiteUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const withProtocol = ABSOLUTE_URL_REGEX.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  try {
    const parsed = new URL(withProtocol);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return null;
    parsed.pathname = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

async function getConfiguredPublicSiteUrl(): Promise<string | null> {
  const row = await db.systemConfig.findUnique({
    where: { key: SITEY_PUBLIC_URL_KEY },
  });
  if (!row?.value) return null;
  return normalizeSiteUrl(row.value);
}

async function getWildcardPublicSiteUrl(): Promise<string | null> {
  const wildcard = await db.domain.findFirst({
    where: {
      hostname: { startsWith: "*." },
      siteySubdomainsEnabled: true,
    },
    orderBy: { createdAt: "asc" },
    select: { hostname: true },
  });
  if (!wildcard) return null;
  return normalizeSiteUrl(`https://sitey.${wildcard.hostname.slice(2)}`);
}

function getEnvPublicSiteUrl(): string | null {
  const raw = process.env.SITEY_URL;
  if (!raw) return null;
  return normalizeSiteUrl(raw);
}

function isUsablePublicUrl(url: string | null): url is string {
  if (!url) return false;
  try {
    return !isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

export async function resolvePublicSiteUrl(): Promise<PublicSiteUrlResolution> {
  const [configuredUrl, wildcardUrl] = await Promise.all([
    getConfiguredPublicSiteUrl(),
    getWildcardPublicSiteUrl(),
  ]);
  const envUrl = getEnvPublicSiteUrl();

  if (isUsablePublicUrl(configuredUrl)) {
    return {
      configuredUrl,
      wildcardUrl,
      envUrl,
      effectiveUrl: configuredUrl,
      source: "config",
    };
  }
  if (isUsablePublicUrl(wildcardUrl)) {
    return {
      configuredUrl,
      wildcardUrl,
      envUrl,
      effectiveUrl: wildcardUrl,
      source: "wildcard",
    };
  }
  if (isUsablePublicUrl(envUrl)) {
    return {
      configuredUrl,
      wildcardUrl,
      envUrl,
      effectiveUrl: envUrl,
      source: "env",
    };
  }
  return {
    configuredUrl,
    wildcardUrl,
    envUrl,
    effectiveUrl: null,
    source: "none",
  };
}

export async function setConfiguredPublicSiteUrl(url: string): Promise<void> {
  await db.systemConfig.upsert({
    where: { key: SITEY_PUBLIC_URL_KEY },
    create: { key: SITEY_PUBLIC_URL_KEY, value: url },
    update: { value: url },
  });
}

export async function clearConfiguredPublicSiteUrl(): Promise<void> {
  await db.systemConfig.deleteMany({ where: { key: SITEY_PUBLIC_URL_KEY } });
}
