import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import {
  buildExportDoc,
  envVarNames,
  renderExportYaml,
  type ExportInput,
} from "../src/services/export.ts";

const route = {
  domainId: null as number | null,
  subdomain: "",
  pathPrefix: "",
  httpOnly: false,
  protected: false,
};

const service = {
  branch: "main",
  deployMode: "server",
  buildCommand: "",
  outputDir: "",
  buildImage: "",
  buildMode: "auto",
  dockerfilePath: "",
  serverRunCommand: "",
  containerPort: 3000,
  envVars: "",
  protected: false,
  active: true,
};

const input: ExportInput = {
  domains: [
    {
      id: 1,
      hostname: "*.example.com",
      letsEncryptEmail: "a@b.c",
      siteySubdomainsEnabled: true,
    },
    {
      id: 2,
      hostname: "landing.dev",
      letsEncryptEmail: "a@b.c",
      siteySubdomainsEnabled: true,
    },
  ],
  repos: [
    { id: 1, name: "sitey", repoOwner: "", repoName: "", githubMode: "app" },
    {
      id: 2,
      name: "site",
      repoOwner: "me",
      repoName: "a",
      githubMode: "webhook",
    },
    {
      id: 3,
      name: "site",
      repoOwner: "me",
      repoName: "b",
      githubMode: "webhook",
    },
  ],
  services: [
    {
      ...service,
      id: 1,
      name: "sitey",
      repoId: 1,
      protected: true,
      routes: [{ ...route, protected: true }],
    },
    {
      ...service,
      id: 2,
      name: "landing",
      repoId: 3,
      deployMode: "static",
      outputDir: "dist",
      envVars: "# comment\nAPI_KEY=secret-value\nexport DB_URL=postgres://x\n",
      routes: [
        { ...route, domainId: 2 },
        { ...route, domainId: 1, subdomain: "landing", pathPrefix: "/beta" },
      ],
    },
  ],
};

test("envVarNames keeps names, drops values and comments", () => {
  assert.deepEqual(envVarNames("# c\nA=1\n\nexport B = 2\r\nC="), [
    "A",
    "B",
    "C",
  ]);
});

test("buildExportDoc references domains and repos by name, omits defaults", () => {
  const doc = buildExportDoc(input);

  assert.deepEqual(doc.domains, [
    {
      hostname: "*.example.com",
      letsEncryptEmail: "a@b.c",
      siteySubdomainsEnabled: true,
    },
    { hostname: "landing.dev", letsEncryptEmail: "a@b.c" },
  ]);

  // Duplicate repo names get the id appended.
  assert.deepEqual(
    doc.repos.map((r) => r.name),
    ["site-2", "site-3", "sitey"],
  );

  assert.deepEqual(doc.services, [
    {
      name: "landing",
      repo: "site-3",
      deployMode: "static",
      outputDir: "dist",
      env: ["API_KEY", "DB_URL"],
      routes: [
        { domain: "*.example.com", subdomain: "landing", pathPrefix: "/beta" },
        { domain: "landing.dev" },
      ],
    },
    {
      name: "sitey",
      repo: "sitey",
      deployMode: "server",
      protected: true,
      routes: [{ protected: true }],
    },
  ]);
});

test("renderExportYaml round-trips and never includes env values", () => {
  const out = renderExportYaml(input, new Date("2026-01-01T00:00:00Z"));
  assert.ok(out.startsWith("# Sitey config export (2026-01-01T00:00:00.000Z)"));
  assert.ok(!out.includes("secret-value"));
  assert.ok(!out.includes("postgres://"));
  assert.deepEqual(
    parse(out),
    JSON.parse(JSON.stringify(buildExportDoc(input))),
  );
});
