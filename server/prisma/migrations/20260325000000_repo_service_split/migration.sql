-- Split Project into Repo + Service, add HookEndpoint + Trigger models.
-- This migration preserves all existing data by creating 1 Repo + 1 Service
-- per old Project (with matching IDs so foreign keys stay valid).

PRAGMA foreign_keys = OFF;

-- ── 1. Create new tables ─────────────────────────────────────────────────────

CREATE TABLE "Repo" (
    "id"         INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name"       TEXT NOT NULL DEFAULT '',
    "repoOwner"  TEXT NOT NULL DEFAULT '',
    "repoName"   TEXT NOT NULL DEFAULT '',
    "githubMode" TEXT NOT NULL DEFAULT 'webhook',
    "createdAt"  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  DATETIME NOT NULL
);

CREATE TABLE "Service" (
    "id"               INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name"             TEXT NOT NULL,
    "repoId"           INTEGER NOT NULL,
    "branch"           TEXT NOT NULL DEFAULT 'main',
    "deployMode"       TEXT NOT NULL DEFAULT 'server',
    "buildCommand"     TEXT NOT NULL DEFAULT '',
    "outputDir"        TEXT NOT NULL DEFAULT '',
    "buildImage"       TEXT NOT NULL DEFAULT '',
    "buildMode"        TEXT NOT NULL DEFAULT 'auto',
    "dockerfilePath"   TEXT NOT NULL DEFAULT '',
    "serverRunCommand" TEXT NOT NULL DEFAULT '',
    "containerPort"    INTEGER NOT NULL DEFAULT 3000,
    "hostPort"         INTEGER,
    "envVars"          TEXT NOT NULL DEFAULT '',
    "status"           TEXT NOT NULL DEFAULT 'idle',
    "containerId"      TEXT,
    "containerName"    TEXT,
    "protected"        BOOLEAN NOT NULL DEFAULT false,
    "active"           BOOLEAN NOT NULL DEFAULT true,
    "createdAt"        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        DATETIME NOT NULL,
    CONSTRAINT "Service_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "HookEndpoint" (
    "id"         TEXT NOT NULL PRIMARY KEY,
    "publicId"   TEXT NOT NULL,
    "secret"     TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "repoId"     INTEGER,
    "enabled"    BOOLEAN NOT NULL DEFAULT true,
    "createdAt"  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  DATETIME NOT NULL,
    CONSTRAINT "HookEndpoint_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "HookEndpoint_publicId_key" ON "HookEndpoint"("publicId");

CREATE TABLE "ServiceRoute" (
    "id"         TEXT NOT NULL PRIMARY KEY,
    "serviceId"  INTEGER NOT NULL,
    "domainId"   INTEGER,
    "subdomain"  TEXT NOT NULL DEFAULT '',
    "pathPrefix" TEXT NOT NULL DEFAULT '',
    "protected"  BOOLEAN NOT NULL DEFAULT false,
    "tlsStatus"  TEXT NOT NULL DEFAULT 'unchecked',
    "httpOnly"   BOOLEAN NOT NULL DEFAULT false,
    "createdAt"  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ServiceRoute_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ServiceRoute_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ServiceRoute_domainId_subdomain_pathPrefix_key" ON "ServiceRoute"("domainId", "subdomain", "pathPrefix");

-- ── 2. Migrate data from Project → Repo + Service ───────────────────────────

-- One Repo per Project (same ID so FKs align)
INSERT INTO "Repo" ("id", "name", "repoOwner", "repoName", "githubMode", "createdAt", "updatedAt")
SELECT "id", "name", "repoOwner", "repoName", "githubMode", "createdAt", "updatedAt"
FROM "Project";

-- One Service per Project (same ID)
INSERT INTO "Service" (
    "id", "name", "repoId", "branch",
    "deployMode", "buildCommand", "outputDir", "buildImage",
    "buildMode", "dockerfilePath", "serverRunCommand",
    "containerPort", "hostPort", "envVars",
    "status", "containerId", "containerName",
    "protected", "active", "createdAt", "updatedAt"
)
SELECT
    "id", "name", "id", "branch",
    "deployMode", "buildCommand", "outputDir", "buildImage",
    "buildMode", "dockerfilePath", "serverRunCommand",
    "containerPort", "hostPort", "envVars",
    "status", "containerId", "containerName",
    "protected", "active", "createdAt", "updatedAt"
FROM "Project";

-- ── 3. Migrate ProjectRoute → ServiceRoute ───────────────────────────────────

INSERT INTO "ServiceRoute" ("id", "serviceId", "domainId", "subdomain", "pathPrefix", "protected", "tlsStatus", "httpOnly", "createdAt")
SELECT "id", "projectId", "domainId", "subdomain", "pathPrefix", "protected", "tlsStatus", "httpOnly", "createdAt"
FROM "ProjectRoute";

-- ── 4. Migrate Deployment (projectId → serviceId) ───────────────────────────

CREATE TABLE "Deployment_new" (
    "id"            TEXT NOT NULL PRIMARY KEY,
    "serviceId"     INTEGER NOT NULL,
    "status"        TEXT NOT NULL DEFAULT 'queued',
    "commitSha"     TEXT,
    "commitMessage" TEXT,
    "logPath"       TEXT,
    "triggeredBy"   TEXT NOT NULL DEFAULT 'manual',
    "startedAt"     DATETIME,
    "finishedAt"    DATETIME,
    "createdAt"     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Deployment_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "Deployment_new" ("id", "serviceId", "status", "commitSha", "commitMessage", "logPath", "triggeredBy", "startedAt", "finishedAt", "createdAt")
SELECT "id", "projectId", "status", "commitSha", "commitMessage", "logPath", "triggeredBy", "startedAt", "finishedAt", "createdAt"
FROM "Deployment";

-- ── 5. Create HookEndpoints for webhook-mode services ────────────────────────

INSERT INTO "HookEndpoint" ("id", "publicId", "secret", "sourceType", "repoId", "enabled", "createdAt", "updatedAt")
SELECT
    lower(hex(randomblob(12))),
    lower(hex(randomblob(16))),
    "webhookSecret",
    'github_webhook',
    "id",
    1,
    "createdAt",
    "updatedAt"
FROM "Project"
WHERE "githubMode" = 'webhook' AND "webhookSecret" IS NOT NULL AND "webhookSecret" != '';

-- ── 6. Drop old tables and rename ────────────────────────────────────────────

DROP TABLE "ProjectRoute";
DROP TABLE "Deployment";
ALTER TABLE "Deployment_new" RENAME TO "Deployment";
DROP TABLE "Project";

PRAGMA foreign_keys = ON;
