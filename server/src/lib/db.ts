import { PrismaClient } from "../generated/prisma/client.js";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

// Runtime Prisma client using the better-sqlite3 driver adapter.
// CLI config (migrations, db push) lives in prisma.config.ts.
export const db = new PrismaClient({
  // Note: Prisma 7 has built-in SQLite support — if you drop the adapter,
  // it'll use Prisma's own query engine to talk to SQLite.
  // Maybe that's better?
  adapter: new PrismaBetterSqlite3({ url: process.env.DATABASE_URL ?? "" }),
  log:
    process.env.NODE_ENV === "development"
      ? ["query", "error", "warn"]
      : ["error"],
});
