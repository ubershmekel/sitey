import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadLocalServer,
  ProfileError,
  selectProfile,
} from "../src/profiles.ts";

const local = { url: "http://127.0.0.1:3001", token: "sitey_local_x" };
const remote = { url: "https://sitey.example.com", token: "sitey_y" };

test("the local server is used only when no profiles exist", () => {
  assert.deepEqual(
    selectProfile({ servers: {} }, undefined, undefined, local),
    {
      name: "(local)",
      profile: local,
    },
  );
  assert.equal(
    selectProfile({ servers: { vps: remote } }, undefined, undefined, local)
      .name,
    "vps",
  );
  assert.throws(
    () => selectProfile({ servers: {} }, "vps", undefined, local),
    ProfileError,
  );
  assert.throws(
    () => selectProfile({ servers: {} }, undefined, undefined, null),
    ProfileError,
  );
});

test("loadLocalServer reads the API's file and tolerates its absence", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "siteyctl-local-"));
  const file = path.join(dir, "local-cli.json");
  assert.equal(loadLocalServer(file), null);
  fs.writeFileSync(file, JSON.stringify(local));
  assert.deepEqual(loadLocalServer(file), local);
  fs.writeFileSync(file, "{not json");
  assert.equal(loadLocalServer(file), null);
  fs.rmSync(dir, { recursive: true });
});
