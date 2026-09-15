import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendRouteHandler,
  PENDING_HEADER,
  type CaddyServiceRoute,
} from "../src/services/caddy.ts";

function render(
  overrides: Partial<NonNullable<CaddyServiceRoute["service"]>>,
  pathPrefix = "",
): string {
  const lines: string[] = [];
  appendRouteHandler(lines, {
    subdomain: "",
    pathPrefix,
    httpOnly: false,
    service: {
      id: 7,
      deployMode: "static",
      status: "queued",
      hasSuccessfulDeployment: false,
      outputDir: "dist",
      containerName: null,
      containerPort: 3000,
      ...overrides,
    },
  });
  return lines.join("\n");
}

test("pending placeholder routes are marked with the pending header", () => {
  for (const prefix of ["", "/app"]) {
    const out = render({}, prefix);
    assert.match(out, /rewrite \* \/pending\.html/);
    assert.match(out, new RegExp(`header ${PENDING_HEADER} 1`), prefix);
  }
  const server = render({ deployMode: "server", containerName: "c" });
  assert.match(server, new RegExp(`header ${PENDING_HEADER} 1`));
});

test("path-prefix routes redirect the bare prefix with an explicit matcher", () => {
  // Without `*`, Caddy reads `redir /app/ 308` as matcher `/app/` + target
  // `308`: the redirect never fires and GET /app answers an empty 200.
  for (const overrides of [
    {},
    { status: "running" },
    { deployMode: "server", containerName: "c", containerRunning: true },
  ]) {
    const out = render(overrides, "/app");
    assert.match(out, /handle \/app \{\n.*\n {8}redir \* \/app\/ 308\n/);
    assert.doesNotMatch(out, /redir \/app\//);
  }
});

test("deployed routes don't carry the pending header", () => {
  for (const prefix of ["", "/app"]) {
    assert.doesNotMatch(
      render({ status: "running" }, prefix),
      /X-Sitey-Pending/,
    );
    assert.doesNotMatch(
      render(
        {
          deployMode: "server",
          containerName: "sitey-service-7",
          containerRunning: true,
        },
        prefix,
      ),
      /X-Sitey-Pending/,
    );
  }
});
