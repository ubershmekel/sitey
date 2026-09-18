-- Existing static services keep serving as single-page apps.
ALTER TABLE "Service" ADD COLUMN "staticRoutingMode" TEXT NOT NULL DEFAULT 'spa';
ALTER TABLE "Service" ADD COLUMN "staticCaddyConfig" TEXT NOT NULL DEFAULT '';
