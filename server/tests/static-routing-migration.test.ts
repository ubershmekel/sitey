import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { appendRouteHandler } from "../src/services/caddy.ts";

const MIGRATIONS = fileURLToPath(
  new URL("../prisma/migrations/", import.meta.url),
);
const TARGET = "20260917000000_static_routing_mode";

test("existing services migrate to SPA routing and render as before", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sitey-migrate-"));
  const db = new Database(path.join(dir, "test.db"));
  try {
    // A pre-upgrade Service table. (Replaying the full history here trips an
    // old migration that relies on SQLite's legacy double-quoted strings.)
    db.exec(`CREATE TABLE "Service" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "name" TEXT NOT NULL,
      "deployMode" TEXT NOT NULL DEFAULT 'server',
      "outputDir" TEXT NOT NULL DEFAULT ''
    )`);
    db.exec(`INSERT INTO Service (id, name, deployMode, outputDir)
             VALUES (5, 'examplesite', 'static', 'dist')`);
    const apply = (name: string) =>
      db.exec(
        fs.readFileSync(path.join(MIGRATIONS, name, "migration.sql"), "utf8"),
      );
    const render = (service: Record<string, unknown>) => {
      const lines: string[] = [];
      appendRouteHandler(lines, {
        subdomain: "",
        pathPrefix: "",
        httpOnly: false,
        service: {
          id: 5,
          deployMode: "static",
          status: "running",
          hasSuccessfulDeployment: true,
          outputDir: "dist",
          containerName: null,
          containerPort: 3000,
          ...service,
        },
      });
      return lines.join("\n");
    };
    const beforeUpgrade = render({});

    apply(TARGET);
    const row = db
      .prepare(
        "SELECT staticRoutingMode, staticCaddyConfig FROM Service WHERE id = 5",
      )
      .get() as { staticRoutingMode: string; staticCaddyConfig: string };
    assert.deepEqual(row, { staticRoutingMode: "spa", staticCaddyConfig: "" });
    assert.equal(render(row), beforeUpgrade);
    assert.match(beforeUpgrade, /try_files \{path\} \/index\.html/);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
