-- Service names become unique so siteyctl can address services by name.
-- Existing rows that would violate the new rules are renamed deterministically,
-- and each rename is recorded in SystemConfig ("service_rename:<id>:<step>") so
-- bootstrap can log it once on the next start.

-- ── 1. Names that look like id references (`42`, `service-42...`) ────────────

INSERT INTO "SystemConfig" ("key", "value", "updatedAt")
SELECT 'service_rename:' || "id" || ':1',
       json_object('id', "id", 'from', "name", 'to', 'svc-' || "id"),
       CURRENT_TIMESTAMP
FROM "Service"
WHERE "name" NOT GLOB '*[^0-9]*' OR "name" GLOB 'service-[0-9]*';

UPDATE "Service"
SET "name" = 'svc-' || "id"
WHERE "name" NOT GLOB '*[^0-9]*' OR "name" GLOB 'service-[0-9]*';

-- ── 2. Duplicates: the lowest id keeps the name, the rest get `-<id>` ────────

INSERT INTO "SystemConfig" ("key", "value", "updatedAt")
SELECT 'service_rename:' || s."id" || ':2',
       json_object('id', s."id", 'from', s."name",
                   'to', substr(s."name", 1, 39 - length(s."id")) || '-' || s."id"),
       CURRENT_TIMESTAMP
FROM "Service" s
WHERE EXISTS (
  SELECT 1 FROM "Service" o WHERE o."name" = s."name" AND o."id" < s."id"
);

UPDATE "Service"
SET "name" = substr("name", 1, 39 - length("id")) || '-' || "id"
WHERE EXISTS (
  SELECT 1 FROM "Service" o WHERE o."name" = "Service"."name" AND o."id" < "Service"."id"
);

-- ── 3. Unique index ──────────────────────────────────────────────────────────

-- CreateIndex
CREATE UNIQUE INDEX "Service_name_key" ON "Service"("name");
