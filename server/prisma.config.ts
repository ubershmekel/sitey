import { defineConfig } from "prisma/config";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

export default defineConfig({
  datasource: {
    url: process.env.DATABASE_URL ?? "",
  },
  adapter: () =>
    new PrismaBetterSqlite3({ url: process.env.DATABASE_URL ?? "" }),
});
