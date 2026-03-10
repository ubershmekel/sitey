-- Normalize ProjectRoute FK column types to match Prisma schema.
-- Some DBs still have ProjectRoute.domainId as TEXT due prior drift.

PRAGMA foreign_keys = OFF;

CREATE TABLE "ProjectRoute_new" (
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

INSERT INTO "ProjectRoute_new" (
  "id",
  "projectId",
  "domainId",
  "subdomain",
  "pathPrefix",
  "protected",
  "createdAt"
)
SELECT
  "id",
  CAST("projectId" AS INTEGER),
  CASE
    WHEN "domainId" IS NULL THEN NULL
    ELSE CAST("domainId" AS INTEGER)
  END,
  "subdomain",
  "pathPrefix",
  "protected",
  "createdAt"
FROM "ProjectRoute";

DROP TABLE "ProjectRoute";
ALTER TABLE "ProjectRoute_new" RENAME TO "ProjectRoute";

CREATE UNIQUE INDEX "ProjectRoute_domainId_subdomain_pathPrefix_key"
ON "ProjectRoute"("domainId", "subdomain", "pathPrefix");

PRAGMA foreign_keys = ON;
