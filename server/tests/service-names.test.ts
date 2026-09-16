import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  formatServiceRef,
  isIdLikeServiceName,
  parseServiceRef,
  serviceNameSchema,
} from "../src/lib/serviceRef.ts";

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../prisma/migrations",
);
const UNIQUE_NAME_MIGRATION = "20260915000000_unique_service_name";

function migrationSql(name: string): string {
  return fs.readFileSync(
    path.join(MIGRATIONS_DIR, name, "migration.sql"),
    "utf8",
  );
}

/** Just the tables the unique-name migration touches, as they were before it. */
function dbBeforeMigration() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE "Service" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "name" TEXT NOT NULL
    );
    CREATE TABLE "ServiceRoute" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "serviceId" INTEGER NOT NULL REFERENCES "Service" ("id") ON DELETE CASCADE
    );
    CREATE TABLE "SystemConfig" (
      "key" TEXT NOT NULL PRIMARY KEY,
      "value" TEXT NOT NULL,
      "updatedAt" DATETIME NOT NULL
    );
  `);
  return db;
}

test("parseServiceRef distinguishes ids from names", () => {
  assert.deepEqual(parseServiceRef("42"), { id: 42 });
  assert.deepEqual(parseServiceRef("service-42"), { id: 42 });
  assert.deepEqual(parseServiceRef(" idea-a "), { name: "idea-a" });
  assert.deepEqual(parseServiceRef("service-42a"), { name: "service-42a" });
  assert.equal(formatServiceRef(42), "service-42");
});

test("names that look like ids are rejected", () => {
  for (const name of ["42", "service-42", "service-4x"]) {
    assert.ok(isIdLikeServiceName(name), name);
    assert.equal(serviceNameSchema.safeParse(name).success, false, name);
  }
  for (const name of ["idea-a", "svc-42", "42-idea", "services-1", "service"]) {
    assert.equal(serviceNameSchema.safeParse(name).success, true, name);
  }
  assert.equal(serviceNameSchema.safeParse("a".repeat(41)).success, false);
  assert.equal(serviceNameSchema.safeParse("Idea").success, false);
});

test("unique-name migration renames duplicates and id-like names, keeps ids and routes", () => {
  const db = dbBeforeMigration();
  const insertService = db.prepare(
    `INSERT INTO "Service" ("id", "name") VALUES (?, ?)`,
  );
  const long = "a".repeat(40);
  const rows: [number, string][] = [
    [1, "site"],
    [2, "site"],
    [7, "site"],
    [3, "42"],
    [4, "service-9"],
    [5, long],
    [123, long],
    [6, "other"],
  ];
  for (const [id, name] of rows) insertService.run(id, name);
  db.exec(`INSERT INTO "ServiceRoute" ("id", "serviceId") VALUES ('r1', 7)`);

  db.exec(migrationSql(UNIQUE_NAME_MIGRATION));

  const names = Object.fromEntries(
    (
      db.prepare(`SELECT "id", "name" FROM "Service"`).all() as {
        id: number;
        name: string;
      }[]
    ).map((r) => [r.id, r.name]),
  );
  assert.deepEqual(names, {
    1: "site",
    2: "site-2",
    7: "site-7",
    3: "svc-3",
    4: "svc-4",
    5: long,
    123: `${"a".repeat(36)}-123`,
    6: "other",
  });
  assert.ok(names[123].length <= 40);

  const route = db
    .prepare(`SELECT "serviceId" FROM "ServiceRoute" WHERE "id" = 'r1'`)
    .get() as { serviceId: number };
  assert.equal(route.serviceId, 7);

  const log = db
    .prepare(
      `SELECT "value" FROM "SystemConfig" WHERE "key" LIKE 'service_rename:%' ORDER BY "key"`,
    )
    .all() as { value: string }[];
  assert.deepEqual(
    log.map((r) => JSON.parse(r.value)),
    [
      { id: 123, from: long, to: `${"a".repeat(36)}-123` },
      { id: 2, from: "site", to: "site-2" },
      { id: 3, from: "42", to: "svc-3" },
      { id: 4, from: "service-9", to: "svc-4" },
      { id: 7, from: "site", to: "site-7" },
    ],
  );

  assert.throws(() => insertService.run(8, "site"), /UNIQUE/);
});

test("migration reserves existing suffixes and id-name replacements", () => {
  const db = dbBeforeMigration();
  const rows = [
    [1, "landing"],
    [2, "landing-3"],
    [3, "landing"],
    [4, "42"],
    [5, "svc-4"],
    [6, "svc-4-1"],
    [7, "svc-3-1"],
    [8, "service-99"],
    [9, "svc-8"],
    [10, "landing"],
  ] as const;
  for (const row of rows)
    db.prepare("INSERT INTO Service(id,name) VALUES (?,?)").run(...row);
  db.exec(migrationSql(UNIQUE_NAME_MIGRATION));
  const names = db.prepare("SELECT id,name FROM Service ORDER BY id").all() as {
    id: number;
    name: string;
  }[];
  assert.equal(new Set(names.map((s) => s.name)).size, rows.length);
  for (const row of names)
    assert.ok(serviceNameSchema.safeParse(row.name).success);
  assert.equal(names[0].name, "landing");
  assert.equal(names[1].name, "landing-3");
  assert.equal(names[2].name, "svc-3-2");
  assert.equal(names[3].name, "svc-4-2");
  db.close();
});
