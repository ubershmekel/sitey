import { execSync } from "child_process";

const steps = [
  {
    name: "test:format",
    cmd: "npm run test:format",
    advice: "Run `npm run format` to auto-fix formatting issues.",
  },
  {
    name: "test:types",
    cmd: "npm run test:types",
    advice: "Fix the TypeScript/Prisma type errors shown above.",
  },
  {
    name: "test:unit",
    cmd: "npm run test:unit",
    advice: "Fix the failing unit tests shown above.",
  },
  {
    name: "test:e2e-local",
    cmd: "npm run test:e2e-local",
    advice:
      "Fix the failing local e2e tests, then re-run `npm run test:e2e-local`.",
  },
  {
    name: "test:updater",
    cmd: "npm run test:updater",
    advice:
      "Fix the failing updater tests, then re-run `npm run test:updater`.",
  },
  {
    name: "test:e2e-cloud",
    cmd: "npm run test:e2e-cloud:worktree",
    advice:
      "Fix the failing cloud e2e tests, then re-run `npm run test:e2e-cloud:worktree`.",
  },
];

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const results: { name: string; ms: number; passed: boolean }[] = [];
let failedStep: (typeof steps)[0] | null = null;

for (const step of steps) {
  const start = Date.now();
  let passed = true;
  try {
    execSync(step.cmd, { stdio: "inherit" });
  } catch {
    passed = false;
    failedStep = step;
  }
  results.push({ name: step.name, ms: Date.now() - start, passed });
  if (!passed) break;
}

const remainingTests = steps.length - results.length;

console.log("\n--- test:all ---");

for (const { name, ms, passed } of results) {
  const icon = passed ? "✓" : "✗";
  console.log(`  ${icon}  ${name.padEnd(18)} ${formatDuration(ms)}`);
}

if (remainingTests > 0) {
  const remainingTestNames = steps.slice(results.length).map((s) => s.name);
  console.log(
    `  -  ${remainingTests} test step${remainingTests > 1 ? "s" : ""} not started: ${remainingTestNames.join(", ")}`,
  );
}
if (failedStep) {
  console.error(`\nFailed: ${failedStep.name}`);
  console.error(`Advice: ${failedStep.advice}`);
  process.exit(1);
}
