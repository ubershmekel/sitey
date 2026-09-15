import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { envVarNames } from "../src/lib/envFile.ts";
import {
  buildExportDoc,
  renderExportYaml,
  type ExportInput,
} from "../src/services/export.ts";

const route = {
  domainId: null as number | null,
  subdomain: "",
  pathPrefix: "",
  httpOnly: false,
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

const domain = { letsEncryptEmail: "", siteySubdomainsEnabled: true };

const input: ExportInput = {
  siteyUrl: "https://sitey.andluck.com",
  domains: [
    { ...domain, id: 1, hostname: "*.andluck.com" },
    { ...domain, id: 2, hostname: "andluck.com" },
    {
      ...domain,
      id: 3,
      hostname: "*.s.andluck.com",
      siteySubdomainsEnabled: false,
    },
    { ...domain, id: 4, hostname: "localhost" },
    { ...domain, id: 5, hostname: "apex.dev", letsEncryptEmail: "me@x.dev" },
  ],
  repos: [
    { id: 1, name: "sitey", repoOwner: "", repoName: "", githubMode: "app" },
    {
      id: 2,
      name: "myswe",
      repoOwner: "ubershmekel",
      repoName: "myswe",
      githubMode: "app",
    },
    {
      id: 3,
      name: "legacy",
      repoOwner: "me",
      repoName: "legacy",
      githubMode: "webhook",
    },
  ],
  services: [
    {
      ...service,
      id: 43,
      name: "idea-b-api",
      repoId: 2,
      serverRunCommand: "cd services/idea-b-api && npm start",
      envVars:
        "STRIPE_KEY=sk_live_secret\n# comment\nDATABASE_URL=postgres://x",
      routes: [
        { ...route, domainId: 1, subdomain: "idea-b", pathPrefix: "/api" },
      ],
    },
    {
      ...service,
      id: 1,
      name: "sitey",
      repoId: 1,
      protected: true,
      routes: [route],
    },
    {
      ...service,
      id: 42,
      name: "idea-a",
      repoId: 2,
      deployMode: "static",
      buildImage: "node:24-bookworm-slim",
      buildCommand: "cd landings/idea-a && npm ci && npm run build",
      outputDir: "landings/idea-a/dist",
      routes: [
        { ...route, domainId: 1, subdomain: "idea-a" },
        { ...route, domainId: 4, pathPrefix: "/red", httpOnly: true },
        { ...route, domainId: 2 },
      ],
    },
    {
      ...service,
      id: 9,
      name: "old",
      repoId: 3,
      active: false,
      containerPort: 8080,
      routes: [],
    },
  ],
};

test("envVarNames keeps names, drops values, comments and repeats", () => {
  assert.deepEqual(envVarNames("# c\nA=1\n\nexport B = 2\r\nC=\nA=3"), [
    "A",
    "B",
    "C",
  ]);
});

test("envVarNames skips lines without '=' (e.g. multi-line secret bodies)", () => {
  assert.deepEqual(
    envVarNames(
      "KEY=-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0\n-----END PRIVATE KEY-----\nghp_tokenOnItsOwnLine\nB=2",
    ),
    ["KEY", "B"],
  );
});

test("buildExportDoc keys services by id, writes route strings, omits defaults", () => {
  assert.deepEqual(buildExportDoc(input), {
    version: 1,
    siteyUrl: "https://sitey.andluck.com",
    domains: [
      "andluck.com",
      "*.andluck.com",
      { hostname: "*.s.andluck.com", siteySubdomains: false },
      { hostname: "apex.dev", letsEncryptEmail: "me@x.dev" },
      "localhost",
    ],
    services: {
      "service-9": {
        name: "old",
        repo: "me/legacy",
        githubMode: "webhook",
        active: false,
        deployMode: "server",
        containerPort: 8080,
      },
      "service-42": {
        name: "idea-a",
        repo: "ubershmekel/myswe",
        deployMode: "static",
        buildImage: "node:24-bookworm-slim",
        buildCommand: "cd landings/idea-a && npm ci && npm run build",
        outputDir: "landings/idea-a/dist",
        routes: ["andluck.com", "http://localhost/red", "idea-a.andluck.com"],
      },
      "service-43": {
        name: "idea-b-api",
        repo: "ubershmekel/myswe",
        deployMode: "server",
        serverRunCommand: "cd services/idea-b-api && npm start",
        env: ["DATABASE_URL", "STRIPE_KEY"],
        routes: ["idea-b.andluck.com/api"],
      },
    },
  });
});

test("services keep their order by numeric id in the YAML", () => {
  const out = renderExportYaml(input);
  assert.ok(out.indexOf("service-9:") < out.indexOf("service-42:"));
  assert.ok(out.indexOf("service-42:") < out.indexOf("service-43:"));
});

test("renderExportYaml is byte-identical across runs and input order", () => {
  const shuffled: ExportInput = {
    ...input,
    domains: [...input.domains].reverse(),
    repos: [...input.repos].reverse(),
    services: [...input.services].reverse().map((s) => ({
      ...s,
      routes: [...s.routes].reverse(),
    })),
  };
  const first = renderExportYaml(input);
  assert.equal(renderExportYaml(input), first);
  assert.equal(renderExportYaml(shuffled), first);
});

test("renderExportYaml round-trips and never includes env values", () => {
  const out = renderExportYaml(input);
  assert.ok(out.startsWith("# Sitey config export."));
  assert.ok(!out.includes("sk_live_secret"));
  assert.ok(!out.includes("postgres://"));
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(out), "no timestamps");
  assert.deepEqual(parse(out), buildExportDoc(input));
});

test("renderExportYaml separates sections and services with blank lines", () => {
  const out = renderExportYaml(input);
  assert.match(out, /\n\ndomains:\n/);
  assert.match(out, /\n\nservices:\n/);
  assert.match(out, /\n\n {2}service-42:\n/);
});
