-- CreateTable
CREATE TABLE "GithubIntegration" (
    "id" INTEGER NOT NULL PRIMARY KEY DEFAULT 1,
    "appId" TEXT,
    "privateKey" TEXT,
    "webhookSecret" TEXT,
    "appSlug" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- Backfill from legacy SystemConfig keys if present (non-destructive)
INSERT INTO "GithubIntegration" (
    "id",
    "appId",
    "privateKey",
    "webhookSecret",
    "appSlug",
    "createdAt",
    "updatedAt"
)
SELECT
    1,
    app_id."value",
    private_key."value",
    webhook_secret."value",
    app_slug."value",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM (SELECT 1) AS seed
LEFT JOIN "SystemConfig" AS app_id
    ON app_id."key" = 'github_app_id'
LEFT JOIN "SystemConfig" AS private_key
    ON private_key."key" = 'github_app_private_key'
LEFT JOIN "SystemConfig" AS webhook_secret
    ON webhook_secret."key" = 'github_app_webhook_secret'
LEFT JOIN "SystemConfig" AS app_slug
    ON app_slug."key" = 'github_app_slug'
WHERE
    app_id."value" IS NOT NULL
    OR private_key."value" IS NOT NULL
    OR webhook_secret."value" IS NOT NULL
    OR app_slug."value" IS NOT NULL;