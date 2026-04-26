import { test } from "node:test";
import assert from "node:assert/strict";
import { runDeployment } from "../src/services/deployment.ts";
import type { DeployDeps } from "../src/services/deployment.ts";
import type {
  Deployment,
  Service,
  Repo,
} from "../src/generated/prisma/client.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FAKE_SHA = "abc123def456feed";

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 1,
    repoOwner: "owner",
    repoName: "repo",
    githubMode: "webhook",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as Repo;
}

function makeService(
  overrides: Partial<Service & { repo: Repo; routes: unknown[] }> = {},
): Service & { repo: Repo; routes: unknown[] } {
  return {
    id: 1,
    name: "my-service",
    deployMode: "server",
    buildMode: "managed",
    buildCommand: "",
    serverRunCommand: "node dist/index.js",
    containerPort: 3000,
    hostPort: null,
    outputDir: "",
    envVars: "",
    dockerfilePath: null,
    buildImage: null,
    branch: "main",
    status: "idle",
    containerId: null,
    containerName: null,
    repoId: 1,
    repo: makeRepo(),
    routes: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as Service & { repo: Repo; routes: unknown[] };
}

function makeDeployment(overrides: Partial<Deployment> = {}): Deployment {
  return {
    id: 1,
    serviceId: 1,
    status: "pending",
    commitSha: null,
    commitMessage: null,
    logPath: null,
    startedAt: null,
    finishedAt: null,
    createdAt: new Date(),
    ...overrides,
  } as unknown as Deployment;
}

// ── Deps factory ──────────────────────────────────────────────────────────────

function makeDeps(overrides: Partial<DeployDeps> = {}): DeployDeps {
  return {
    db: {
      deployment: {
        update: async () => ({}),
        findMany: async () => [],
      },
      service: {
        update: async () => ({}),
        findUniqueOrThrow: async () => {
          throw new Error("not implemented");
        },
      },
      systemConfig: {
        findUnique: async () => null,
      },
    } as unknown as DeployDeps["db"],
    cloneOrPull: async () => ({ sha: FAKE_SHA, message: "feat: initial" }),
    getInstallationToken: async () => null,
    buildImage: async () => {},
    runOrReplaceContainer: async () => "cid-abc123",
    stopAndRemoveContainer: async () => {},
    createNetworkIfMissing: async () => {},
    pruneServiceImages: async () => {},
    allocateHostPort: async () => 8080,
    inspectContainer: async () => ({
      State: { Running: true, Status: "running" },
    }),
    reloadCaddy: async () => {},
    isTrackedFile: async () => false,
    runBuildContainer: async () => {},
    spawnBuild: async () => {},
    sleep: async () => {},
    createWriteStream: () => ({ write: () => {}, end: () => {} }),
    mkdirSync: () => {},
    writeFileSync: () => {},
    existsSync: () => false,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("server deploy: marks deployment success and service running with containerId", async () => {
  const deploymentUpdates: Record<string, unknown>[] = [];
  const serviceUpdates: Record<string, unknown>[] = [];

  const deps = makeDeps({
    db: {
      deployment: {
        update: async (args: { data: Record<string, unknown> }) => {
          deploymentUpdates.push(args.data);
          return args.data;
        },
        findMany: async () => [],
      },
      service: {
        update: async (args: { data: Record<string, unknown> }) => {
          serviceUpdates.push(args.data);
          return args.data;
        },
      },
      systemConfig: { findUnique: async () => null },
    } as unknown as DeployDeps["db"],
    runOrReplaceContainer: async () => "cid-deadbeef",
  });

  await runDeployment(makeService(), makeDeployment(), deps);

  const successUpdate = deploymentUpdates.find((u) => u.status === "success");
  assert.ok(successUpdate, "deployment should be marked success");
  assert.ok(successUpdate.finishedAt instanceof Date);

  const runningUpdate = serviceUpdates.find((u) => u.status === "running");
  assert.ok(runningUpdate, "service should be marked running");
  assert.equal(runningUpdate.containerId, "cid-deadbeef");
  assert.equal(runningUpdate.containerName, "sitey-service-1");
});

test("server deploy: reloads caddy once on success", async () => {
  let caddyReloads = 0;
  const deps = makeDeps({
    reloadCaddy: async () => {
      caddyReloads++;
    },
  });

  await runDeployment(makeService(), makeDeployment(), deps);

  assert.equal(caddyReloads, 1);
});

test("static deploy: runs build, marks success, no container", async () => {
  let buildRan = false;
  const serviceUpdates: Record<string, unknown>[] = [];

  const deps = makeDeps({
    db: {
      deployment: { update: async () => ({}), findMany: async () => [] },
      service: {
        update: async (args: { data: Record<string, unknown> }) => {
          serviceUpdates.push(args.data);
          return args.data;
        },
      },
      systemConfig: { findUnique: async () => null },
    } as unknown as DeployDeps["db"],
    spawnBuild: async () => {
      buildRan = true;
    },
  });

  await runDeployment(
    makeService({ deployMode: "static" }),
    makeDeployment(),
    deps,
  );

  assert.ok(buildRan, "build command should run");
  const runningUpdate = serviceUpdates.find((u) => u.status === "running");
  assert.ok(runningUpdate);
  assert.equal(runningUpdate.containerId, null);
  assert.equal(runningUpdate.containerName, null);
});

test("static deploy: fails when outputDir is missing after build", async () => {
  const serviceUpdates: Record<string, unknown>[] = [];

  const deps = makeDeps({
    db: {
      deployment: { update: async () => ({}), findMany: async () => [] },
      service: {
        update: async (args: { data: Record<string, unknown> }) => {
          serviceUpdates.push(args.data);
          return args.data;
        },
      },
      systemConfig: { findUnique: async () => null },
    } as unknown as DeployDeps["db"],
    spawnBuild: async () => {},
    existsSync: () => false,
  });

  await runDeployment(
    makeService({ deployMode: "static", outputDir: "dist" }),
    makeDeployment(),
    deps,
  );

  const failedUpdate = serviceUpdates.find((u) => u.status === "failed");
  assert.ok(failedUpdate, "service should be marked failed");
});

test("git failure: marks deployment and service failed", async () => {
  const deploymentUpdates: Record<string, unknown>[] = [];
  const serviceUpdates: Record<string, unknown>[] = [];

  const deps = makeDeps({
    db: {
      deployment: {
        update: async (args: { data: Record<string, unknown> }) => {
          deploymentUpdates.push(args.data);
          return args.data;
        },
        findMany: async () => [],
      },
      service: {
        update: async (args: { data: Record<string, unknown> }) => {
          serviceUpdates.push(args.data);
          return args.data;
        },
      },
      systemConfig: { findUnique: async () => null },
    } as unknown as DeployDeps["db"],
    cloneOrPull: async () => {
      throw new Error("git: repo not found");
    },
  });

  await runDeployment(makeService(), makeDeployment(), deps);

  assert.ok(
    deploymentUpdates.find((u) => u.status === "failed"),
    "deployment should be marked failed",
  );
  assert.ok(
    serviceUpdates.find((u) => u.status === "failed"),
    "service should be marked failed",
  );
});

test("container crash: marks failed with helpful message", async () => {
  const deploymentUpdates: Record<string, unknown>[] = [];

  const deps = makeDeps({
    db: {
      deployment: {
        update: async (args: { data: Record<string, unknown> }) => {
          deploymentUpdates.push(args.data);
          return args.data;
        },
        findMany: async () => [],
      },
      service: { update: async () => ({}) },
      systemConfig: { findUnique: async () => null },
    } as unknown as DeployDeps["db"],
    inspectContainer: async () => ({
      State: { Running: false, Status: "exited" },
    }),
  });

  await runDeployment(makeService(), makeDeployment(), deps);

  assert.ok(
    deploymentUpdates.find((u) => u.status === "failed"),
    "deployment should be marked failed after container crash",
  );
});
