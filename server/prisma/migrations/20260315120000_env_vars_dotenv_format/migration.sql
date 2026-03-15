-- Convert envVars from JSON format to .env format
-- Change default from '{}' to '' and migrate existing empty JSON objects

-- Update existing rows that have the old JSON default
UPDATE "Project" SET "envVars" = '' WHERE "envVars" = '{}';
