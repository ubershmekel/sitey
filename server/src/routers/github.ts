import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, settledProcedure } from "../trpc.ts";
import { db } from "../lib/db.ts";
import { normalizeSiteUrl, resolvePublicSiteUrl } from "../services/siteUrl.ts";
import {
  clearGithubIntegrationConfig,
  getConfig,
  getGithubIntegrationConfig,
  setGithubIntegrationSlug,
  setConfig,
  upsertGithubIntegrationConfig,
  createAppJwt,
  githubFetch,
} from "../services/github.ts";

const GITHUB_APP_REPO_CACHE_KEY = "github_app_repo_cache_v1";
const GITHUB_APP_REPO_CACHE_CHECKED_AT_KEY = "github_app_repo_cache_checked_at";
const GITHUB_APP_REPO_CACHE_ERROR_KEY = "github_app_repo_cache_error";
const GITHUB_APP_REPO_REFRESH_MIN_INTERVAL_MS = 30_000;

type CachedAppInstallation = {
  id: number;
  accountLogin: string;
  accountType: string;
  repoCount: number;
};

type CachedAppRepo = {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string | null;
  installationId: string;
};

type CachedAppRepoInfo = {
  installations: CachedAppInstallation[];
  app: {
    slug: string | null;
    name: string | null;
    installUrl: string | null;
  };
  repos: CachedAppRepo[];
};

let appRepoRefreshInFlight: Promise<void> | null = null;
let appRepoRefreshStartedAt = 0;

function isWildcardDomain(hostname: string): boolean {
  return hostname.startsWith("*.");
}

function splitOwnerRepo(fullName: string) {
  const [owner, name] = fullName.split("/");
  return {
    owner: owner ?? "",
    name: name ?? "",
  };
}

function parseCachedAppRepoInfo(raw: string | null): CachedAppRepoInfo | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CachedAppRepoInfo>;
    if (
      !parsed ||
      !Array.isArray(parsed.installations) ||
      !Array.isArray(parsed.repos) ||
      typeof parsed.app !== "object" ||
      parsed.app === null
    ) {
      return null;
    }
    return {
      installations: parsed.installations as CachedAppInstallation[],
      repos: parsed.repos as CachedAppRepo[],
      app: {
        slug:
          typeof parsed.app.slug === "string" || parsed.app.slug === null
            ? parsed.app.slug
            : null,
        name:
          typeof parsed.app.name === "string" || parsed.app.name === null
            ? parsed.app.name
            : null,
        installUrl:
          typeof parsed.app.installUrl === "string" ||
          parsed.app.installUrl === null
            ? parsed.app.installUrl
            : null,
      },
    };
  } catch {
    return null;
  }
}

async function clearCachedAppRepoInfo() {
  await db.systemConfig.deleteMany({
    where: {
      key: {
        in: [
          GITHUB_APP_REPO_CACHE_KEY,
          GITHUB_APP_REPO_CACHE_CHECKED_AT_KEY,
          GITHUB_APP_REPO_CACHE_ERROR_KEY,
        ],
      },
    },
  });
}

function toErrorMessage(error: unknown): string {
  if (error instanceof TRPCError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

async function fetchLiveAppRepoInfo(
  appId: string,
  privateKey: string,
): Promise<CachedAppRepoInfo> {
  let appJwt = "";
  try {
    appJwt = createAppJwt(appId, privateKey);
  } catch {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid GitHub App private key.",
    });
  }

  let appSlug: string | null = null;
  let appName: string | null = null;
  try {
    const appRes = await githubFetch("/app", {
      headers: { Authorization: `Bearer ${appJwt}` },
    });
    if (appRes.ok) {
      const appData = (await appRes.json()) as {
        slug?: string;
        name?: string;
      };
      appSlug = appData.slug ?? null;
      appName = appData.name ?? null;
    }
  } catch {
    // Best-effort metadata; keep going.
  }

  const rawInstallations: {
    id: number;
    accountLogin: string;
    accountType: string;
  }[] = [];
  for (let page = 1; ; page++) {
    const res = await githubFetch(
      `/app/installations?per_page=100&page=${page}`,
      {
        headers: { Authorization: `Bearer ${appJwt}` },
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `GitHub API error: ${text}`,
      });
    }
    const rows = (await res.json()) as Array<{
      id: number;
      account: { login: string; type: string } | null;
    }>;
    rawInstallations.push(
      ...rows.map((r) => ({
        id: r.id,
        accountLogin: r.account?.login ?? "unknown",
        accountType: r.account?.type ?? "User",
      })),
    );
    if (rows.length < 100) break;
  }

  const deduped = new Map<string, CachedAppRepo>();
  const installationsWithCounts: CachedAppInstallation[] = [];

  for (const installation of rawInstallations) {
    const tokenRes = await githubFetch(
      `/app/installations/${installation.id}/access_tokens`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${appJwt}` },
      },
    );
    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `GitHub API error: ${text}`,
      });
    }
    const tokenData = (await tokenRes.json()) as { token: string };
    const accessToken = tokenData.token;

    let repoCount = 0;
    for (let page = 1; ; page++) {
      const reposRes = await githubFetch(
        `/installation/repositories?per_page=100&page=${page}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      );
      if (!reposRes.ok) {
        const text = await reposRes.text();
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `GitHub API error: ${text}`,
        });
      }
      const payload = (await reposRes.json()) as {
        repositories: Array<{
          id: number;
          full_name: string;
          private: boolean;
          default_branch: string | null;
        }>;
      };

      for (const repo of payload.repositories) {
        const parsed = splitOwnerRepo(repo.full_name);
        deduped.set(repo.full_name.toLowerCase(), {
          id: repo.id,
          owner: parsed.owner,
          name: parsed.name,
          fullName: repo.full_name,
          private: repo.private,
          defaultBranch: repo.default_branch,
          installationId: String(installation.id),
        });
      }
      repoCount += payload.repositories.length;
      if (payload.repositories.length < 100) break;
    }

    installationsWithCounts.push({ ...installation, repoCount });
  }

  return {
    installations: installationsWithCounts,
    app: {
      slug: appSlug,
      name: appName,
      installUrl: appSlug
        ? `https://github.com/apps/${appSlug}/installations/new`
        : null,
    },
    repos: Array.from(deduped.values()).sort((a, b) =>
      a.fullName.localeCompare(b.fullName),
    ),
  };
}

function refreshAppRepoCacheInBackground(force = false) {
  const now = Date.now();
  if (appRepoRefreshInFlight) return;
  if (
    !force &&
    now - appRepoRefreshStartedAt < GITHUB_APP_REPO_REFRESH_MIN_INTERVAL_MS
  ) {
    return;
  }

  appRepoRefreshStartedAt = now;
  appRepoRefreshInFlight = (async () => {
    try {
      const { appId, privateKey } = await getGithubIntegrationConfig();
      if (!appId || !privateKey) {
        await clearCachedAppRepoInfo();
        return;
      }

      const live = await fetchLiveAppRepoInfo(appId, privateKey);
      const checkedAt = new Date().toISOString();
      await Promise.all([
        setConfig(GITHUB_APP_REPO_CACHE_KEY, JSON.stringify(live)),
        setConfig(GITHUB_APP_REPO_CACHE_CHECKED_AT_KEY, checkedAt),
        setConfig(GITHUB_APP_REPO_CACHE_ERROR_KEY, ""),
      ]);
    } catch (error) {
      await setConfig(GITHUB_APP_REPO_CACHE_ERROR_KEY, toErrorMessage(error));
    } finally {
      appRepoRefreshInFlight = null;
    }
  })();
}

async function resolveBaseUrl(
  hostname?: string,
): Promise<{ url: string; source: "domain" | "config" | "wildcard" | "env" }> {
  if (hostname) {
    const fromDomain = normalizeSiteUrl(`https://${hostname}`);
    if (!fromDomain) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Invalid domain hostname: ${hostname}`,
      });
    }
    return { url: fromDomain, source: "domain" };
  }

  const resolved = await resolvePublicSiteUrl();
  if (!resolved.effectiveUrl || resolved.source === "none") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Public Site URL is not configured. Configure it in Settings or enable Sitey subdomains on a wildcard domain.",
    });
  }
  return {
    url: resolved.effectiveUrl,
    source: resolved.source,
  };
}

export const githubRouter = router({
  /** Returns the GitHub App manifest form data for one-click app creation */
  getManifest: settledProcedure
    .input(z.object({ domainId: z.number().int().optional() }))
    .query(async ({ input }) => {
      const domains = await db.domain.findMany({
        select: { id: true, hostname: true },
        orderBy: { createdAt: "asc" },
      });
      const hasWildcardDomains = domains.some((d: { hostname: string }) =>
        isWildcardDomain(d.hostname),
      );
      const manifestDomains = domains.filter(
        (d: { id: number; hostname: string }) => !isWildcardDomain(d.hostname),
      );
      const chosen = input.domainId
        ? manifestDomains.find(
            (d: { id: number; hostname: string }) => d.id === input.domainId,
          )
        : null;
      const fallbackHostname =
        manifestDomains.length === 1 ? manifestDomains[0].hostname : undefined;
      const baseUrl = chosen?.hostname
        ? await resolveBaseUrl(chosen.hostname)
        : await resolveBaseUrl().catch((err) => {
            if (fallbackHostname) return resolveBaseUrl(fallbackHostname);
            throw err;
          });
      const siteUrl = baseUrl.url;
      const hostname = (() => {
        try {
          return new URL(siteUrl).hostname;
        } catch {
          return "sitey";
        }
      })();
      const name = `sitey-${hostname}`.slice(0, 34);
      const manifest = {
        name,
        url: siteUrl,
        hook_attributes: { url: `${siteUrl}/webhook/github`, active: true },
        redirect_url: `${siteUrl}/github/app/callback`,
        default_permissions: { contents: "read" },
        default_events: ["push"],
        public: true,
      };
      return {
        actionUrl: "https://github.com/settings/apps/new",
        manifest: JSON.stringify(manifest),
        domains: manifestDomains,
        hasWildcardDomains,
        effectiveSiteUrl: siteUrl,
        effectiveSiteUrlSource: baseUrl.source,
      };
    }),

  /** Exchanges the GitHub manifest code for full app credentials and stores them */
  exchangeManifestCode: settledProcedure
    .input(z.object({ code: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const res = await fetch(
        `https://api.github.com/app-manifests/${input.code}/conversions`,
        {
          method: "POST",
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
      );
      if (!res.ok) {
        const text = await res.text();
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `GitHub API error: ${text}`,
        });
      }
      const data = (await res.json()) as {
        id: number;
        slug?: string;
        pem: string;
        webhook_secret: string;
      };
      await upsertGithubIntegrationConfig({
        appId: String(data.id),
        privateKey: data.pem,
        webhookSecret: data.webhook_secret,
        appSlug: data.slug ?? null,
      });
      return { ok: true, appId: String(data.id) };
    }),

  getAppConfig: settledProcedure.query(async () => {
    const { appId, privateKey, webhookSecret, appSlug } =
      await getGithubIntegrationConfig();
    const hasPrivateKey = !!privateKey;
    const hasWebhookSecret = !!webhookSecret;
    const installUrl = appSlug
      ? `https://github.com/apps/${appSlug}/installations/new`
      : null;
    return {
      appId,
      hasPrivateKey,
      hasWebhookSecret,
      configured: !!appId && hasPrivateKey,
      installUrl,
    };
  }),

  setAppConfig: settledProcedure
    .input(
      z.object({
        appId: z.string().min(1),
        privateKey: z.string().min(1),
        webhookSecret: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      await upsertGithubIntegrationConfig({
        appId: input.appId,
        privateKey: input.privateKey,
        webhookSecret: input.webhookSecret,
      });
      await clearCachedAppRepoInfo();
      try {
        const appJwt = createAppJwt(input.appId, input.privateKey);
        const appRes = await githubFetch("/app", {
          headers: { Authorization: `Bearer ${appJwt}` },
        });
        if (appRes.ok) {
          const appData = (await appRes.json()) as { slug?: string };
          if (appData.slug) await setGithubIntegrationSlug(appData.slug);
        }
      } catch {
        /* best-effort */
      }
      refreshAppRepoCacheInBackground(true);
      return { ok: true };
    }),

  clearAppConfig: settledProcedure.mutation(async () => {
    await clearGithubIntegrationConfig();
    await clearCachedAppRepoInfo();
    return { ok: true };
  }),

  listAppRepos: settledProcedure.query(async () => {
    const { appId, privateKey } = await getGithubIntegrationConfig();
    if (!appId || !privateKey) {
      return {
        configured: false as const,
        installations: 0,
        refreshing: false,
        app: {
          slug: null as string | null,
          name: null as string | null,
          installUrl: null as string | null,
        },
        repos: [],
      };
    }
    const [cachedRaw, statusCheckedAt, lastError] = await Promise.all([
      getConfig(GITHUB_APP_REPO_CACHE_KEY),
      getConfig(GITHUB_APP_REPO_CACHE_CHECKED_AT_KEY),
      getConfig(GITHUB_APP_REPO_CACHE_ERROR_KEY),
    ]);
    const cached = parseCachedAppRepoInfo(cachedRaw);

    // Return cache immediately and refresh in background.
    refreshAppRepoCacheInBackground(!cached);

    if (!cached) {
      return {
        configured: true as const,
        installations: [],
        refreshing: !!appRepoRefreshInFlight,
        app: {
          slug: null as string | null,
          name: null as string | null,
          installUrl: null as string | null,
        },
        repos: [],
        statusCheckedAt,
        lastError: lastError || null,
      };
    }

    return {
      configured: true as const,
      installations: cached.installations,
      refreshing: !!appRepoRefreshInFlight,
      app: cached.app,
      repos: cached.repos,
      statusCheckedAt,
      lastError: lastError || null,
    };
  }),
});
