-- Reserve all original and preferred names before assigning replacements.
-- This migration is intentionally repaired in place: a later migration cannot
-- rescue an upgrade that fails while creating this unique index.
CREATE TEMP TABLE service_name_plan (
  id INTEGER PRIMARY KEY,
  old_name TEXT NOT NULL,
  preferred TEXT NOT NULL,
  step INTEGER NOT NULL,
  new_name TEXT
);

INSERT INTO service_name_plan (id, old_name, preferred, step)
SELECT s.id, s.name,
       CASE WHEN s.name NOT GLOB '*[^0-9]*' OR s.name GLOB 'service-[0-9]*'
            THEN 'svc-' || s.id
            ELSE substr(s.name, 1, 39 - length(s.id)) || '-' || s.id END,
       CASE WHEN s.name NOT GLOB '*[^0-9]*' OR s.name GLOB 'service-[0-9]*'
            THEN 1 ELSE 2 END
FROM Service s
WHERE s.name NOT GLOB '*[^0-9]*' OR s.name GLOB 'service-[0-9]*'
   OR EXISTS (SELECT 1 FROM Service o WHERE o.name = s.name AND o.id < s.id);

-- Fallback candidates include the row id, so different rows cannot generate
-- the same fallback. Also reserve preferred names, even for rows not yet updated.
WITH RECURSIVE choices(id, n, candidate) AS (
  SELECT id, 0, preferred FROM service_name_plan
  UNION ALL
  SELECT id, n + 1, 'svc-' || id || '-' || (n + 1)
  FROM choices c
  WHERE EXISTS (SELECT 1 FROM Service s WHERE s.name = c.candidate)
     OR EXISTS (SELECT 1 FROM service_name_plan p WHERE p.id != c.id AND p.preferred = c.candidate)
), available AS (
  SELECT id, candidate FROM choices c
  WHERE NOT EXISTS (SELECT 1 FROM Service s WHERE s.name = c.candidate)
    AND NOT EXISTS (SELECT 1 FROM service_name_plan p WHERE p.id != c.id AND p.preferred = c.candidate)
)
UPDATE service_name_plan SET new_name = (SELECT candidate FROM available a WHERE a.id = service_name_plan.id);

INSERT INTO SystemConfig (key, value, updatedAt)
SELECT 'service_rename:' || id || ':' || step,
       json_object('id', id, 'from', old_name, 'to', new_name), CURRENT_TIMESTAMP
FROM service_name_plan;

UPDATE Service SET name = (SELECT new_name FROM service_name_plan p WHERE p.id = Service.id)
WHERE id IN (SELECT id FROM service_name_plan);
DROP TABLE service_name_plan;
CREATE UNIQUE INDEX "Service_name_key" ON Service(name);
