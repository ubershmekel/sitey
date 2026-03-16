import { defineConfig } from "prisma/config";

// Used by the Prisma CLI (migrations, db push, studio, etc.).
// The runtime client is configured separately in src/lib/db.ts.
export default defineConfig({
  datasource: {
    url: process.env.DATABASE_URL ?? "",
  },
});
