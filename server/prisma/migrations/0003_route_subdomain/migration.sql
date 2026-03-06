-- Add subdomain support for wildcard-domain routing.
ALTER TABLE "ProjectRoute" ADD COLUMN "subdomain" TEXT NOT NULL DEFAULT '';

-- Replace old uniqueness scope (domain + path) with domain + subdomain + path.
DROP INDEX IF EXISTS "ProjectRoute_domainId_pathPrefix_key";
CREATE UNIQUE INDEX "ProjectRoute_domainId_subdomain_pathPrefix_key"
ON "ProjectRoute"("domainId", "subdomain", "pathPrefix");
