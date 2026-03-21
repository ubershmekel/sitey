-- Fix schema drift in Project table:
--   • drop githubInstallationId (removed from schema, never got a migration)
--   • change outputDir default from 'dist' to '' (schema already says "")
--   • change envVars default from '{}' to '' (schema already says "")
-- SQLite requires a full table rewrite for these changes.

PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_Project" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "repoOwner" TEXT NOT NULL DEFAULT '',
    "repoName" TEXT NOT NULL DEFAULT '',
    "branch" TEXT NOT NULL DEFAULT 'main',
    "deployMode" TEXT NOT NULL DEFAULT 'server',
    "buildCommand" TEXT NOT NULL DEFAULT '',
    "outputDir" TEXT NOT NULL DEFAULT '',
    "buildImage" TEXT NOT NULL DEFAULT '',
    "buildMode" TEXT NOT NULL DEFAULT 'auto',
    "dockerfilePath" TEXT NOT NULL DEFAULT '',
    "serverRunCommand" TEXT NOT NULL DEFAULT '',
    "containerPort" INTEGER NOT NULL DEFAULT 3000,
    "hostPort" INTEGER,
    "envVars" TEXT NOT NULL DEFAULT '',
    "githubMode" TEXT NOT NULL DEFAULT 'webhook',
    "webhookSecret" TEXT,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "containerId" TEXT,
    "containerName" TEXT,
    "protected" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

INSERT INTO "new_Project" (
    "active", "branch", "buildCommand", "buildImage", "buildMode",
    "containerId", "containerName", "containerPort", "createdAt",
    "deployMode", "dockerfilePath", "envVars", "githubMode", "hostPort",
    "id", "name", "outputDir", "protected", "repoName", "repoOwner",
    "serverRunCommand", "status", "updatedAt", "webhookSecret"
) SELECT
    "active", "branch", "buildCommand", "buildImage", "buildMode",
    "containerId", "containerName", "containerPort", "createdAt",
    "deployMode", "dockerfilePath", "envVars", "githubMode", "hostPort",
    "id", "name", "outputDir", "protected", "repoName", "repoOwner",
    "serverRunCommand", "status", "updatedAt", "webhookSecret"
FROM "Project";

DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
