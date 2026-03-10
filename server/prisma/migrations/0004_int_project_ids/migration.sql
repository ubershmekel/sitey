-- Switch all primary/foreign keys from TEXT (cuid) to INTEGER (autoincrement).
--
-- Domain rows are preserved with new sequential IDs (ordered by createdAt).
-- Project, ProjectRoute, and Deployment rows are dropped — projects must be
-- re-added after this migration. Domain and SystemConfig data is kept.

PRAGMA foreign_keys = OFF;

-- ── Step 1: drop tables that depend on Project and Domain ─────────────────────
DROP TABLE IF EXISTS "Deployment";
DROP TABLE IF EXISTS "ProjectRoute";
DROP TABLE IF EXISTS "Project";

-- ── Step 2: recreate Domain with autoincrement Int, preserving rows ───────────
CREATE TABLE "Domain_new" (
    "id"                     INTEGER  NOT NULL PRIMARY KEY AUTOINCREMENT,
    "hostname"               TEXT     NOT NULL,
    "letsEncryptEmail"       TEXT     NOT NULL,
    "status"                 TEXT     NOT NULL DEFAULT 'pending',
    "statusCheckedAt"        DATETIME,
    "siteySubdomainsEnabled" BOOLEAN  NOT NULL DEFAULT true,
    "createdAt"              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"              DATETIME NOT NULL
);

INSERT INTO "Domain_new" ("hostname", "letsEncryptEmail", "status", "statusCheckedAt", "siteySubdomainsEnabled", "createdAt", "updatedAt")
SELECT "hostname", "letsEncryptEmail", "status", "statusCheckedAt", "siteySubdomainsEnabled", "createdAt", "updatedAt"
FROM "Domain"
ORDER BY "createdAt";

DROP TABLE "Domain";
ALTER TABLE "Domain_new" RENAME TO "Domain";

CREATE UNIQUE INDEX "Domain_hostname_key" ON "Domain"("hostname");

-- ── Step 3: recreate Project with autoincrement Int ───────────────────────────
CREATE TABLE "Project" (
    "id"               INTEGER  NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name"             TEXT     NOT NULL,
    "repoOwner"        TEXT     NOT NULL DEFAULT '',
    "repoName"         TEXT     NOT NULL DEFAULT '',
    "branch"           TEXT     NOT NULL DEFAULT 'main',
    "deployMode"       TEXT     NOT NULL DEFAULT 'server',
    "buildCommand"     TEXT     NOT NULL DEFAULT '',
    "outputDir"        TEXT     NOT NULL DEFAULT '',
    "buildMode"        TEXT     NOT NULL DEFAULT 'auto',
    "serverRunCommand" TEXT     NOT NULL DEFAULT '',
    "containerPort"    INTEGER  NOT NULL DEFAULT 3000,
    "hostPort"         INTEGER,
    "envVars"          TEXT     NOT NULL DEFAULT '{}',
    "githubMode"       TEXT     NOT NULL DEFAULT 'webhook',
    "webhookSecret"    TEXT,
    "githubInstallationId" TEXT,
    "status"           TEXT     NOT NULL DEFAULT 'idle',
    "containerId"      TEXT,
    "containerName"    TEXT,
    "protected"        BOOLEAN  NOT NULL DEFAULT false,
    "createdAt"        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        DATETIME NOT NULL
);

-- ── Step 4: recreate ProjectRoute with Int FKs ────────────────────────────────
CREATE TABLE "ProjectRoute" (
    "id"         TEXT     NOT NULL PRIMARY KEY,
    "projectId"  INTEGER  NOT NULL,
    "domainId"   INTEGER,
    "subdomain"  TEXT     NOT NULL DEFAULT '',
    "pathPrefix" TEXT     NOT NULL DEFAULT '',
    "protected"  BOOLEAN  NOT NULL DEFAULT false,
    "createdAt"  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectRoute_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectRoute_domainId_fkey"  FOREIGN KEY ("domainId")  REFERENCES "Domain"  ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ProjectRoute_domainId_subdomain_pathPrefix_key"
    ON "ProjectRoute"("domainId", "subdomain", "pathPrefix");

-- ── Step 5: recreate Deployment with Int FK ───────────────────────────────────
CREATE TABLE "Deployment" (
    "id"            TEXT     NOT NULL PRIMARY KEY,
    "projectId"     INTEGER  NOT NULL,
    "status"        TEXT     NOT NULL DEFAULT 'queued',
    "commitSha"     TEXT,
    "commitMessage" TEXT,
    "logPath"       TEXT,
    "triggeredBy"   TEXT     NOT NULL DEFAULT 'manual',
    "startedAt"     DATETIME,
    "finishedAt"    DATETIME,
    "createdAt"     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Deployment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

PRAGMA foreign_keys = ON;
