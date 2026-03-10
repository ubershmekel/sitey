-- Repair legacy/non-integer Domain.id values that can survive in SQLite.
-- Rebuild Domain with INTEGER PRIMARY KEY ids and remap ProjectRoute.domainId.

PRAGMA foreign_keys = OFF;

CREATE TABLE "_Domain_id_map" (
  "old_id" TEXT NOT NULL PRIMARY KEY,
  "hostname" TEXT NOT NULL
);

INSERT INTO "_Domain_id_map" ("old_id", "hostname")
SELECT CAST("id" AS TEXT), "hostname"
FROM "Domain";

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

INSERT INTO "Domain_new" (
  "hostname",
  "letsEncryptEmail",
  "status",
  "statusCheckedAt",
  "siteySubdomainsEnabled",
  "createdAt",
  "updatedAt"
)
SELECT
  "hostname",
  "letsEncryptEmail",
  "status",
  "statusCheckedAt",
  "siteySubdomainsEnabled",
  "createdAt",
  "updatedAt"
FROM "Domain"
ORDER BY "createdAt";

DROP TABLE "Domain";
ALTER TABLE "Domain_new" RENAME TO "Domain";

CREATE UNIQUE INDEX "Domain_hostname_key" ON "Domain"("hostname");

UPDATE "ProjectRoute"
SET "domainId" = (
  SELECT d."id"
  FROM "_Domain_id_map" m
  JOIN "Domain" d ON d."hostname" = m."hostname"
  WHERE m."old_id" = CAST("ProjectRoute"."domainId" AS TEXT)
)
WHERE "domainId" IS NOT NULL;

DROP TABLE "_Domain_id_map";

PRAGMA foreign_keys = ON;
