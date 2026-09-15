import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatRouteString,
  parseRouteString,
  resolveRouteHost,
  RouteStringError,
} from "../src/lib/routeString.ts";

const domains = [
  { id: 1, hostname: "andluck.com" },
  { id: 2, hostname: "*.andluck.com" },
  { id: 3, hostname: "*.s.andluck.com" },
  { id: 4, hostname: "localhost" },
];

function resolve(route: string) {
  const parsed = parseRouteString(route);
  const match = resolveRouteHost(parsed.host, domains);
  return match
    ? {
        domain: match.domain.hostname,
        subdomain: match.subdomain,
        pathPrefix: parsed.pathPrefix,
        httpOnly: parsed.httpOnly,
      }
    : null;
}

test("resolver matches the design doc's table", () => {
  const row = (
    domain: string,
    subdomain: string,
    pathPrefix = "",
    httpOnly = false,
  ) => ({ domain, subdomain, pathPrefix, httpOnly });

  assert.deepEqual(
    resolve("idea-a.andluck.com"),
    row("*.andluck.com", "idea-a"),
  );
  assert.deepEqual(resolve("andluck.com"), row("andluck.com", ""));
  assert.deepEqual(resolve("www.andluck.com"), row("*.andluck.com", "www"));
  assert.deepEqual(
    resolve("idea-b.andluck.com/api"),
    row("*.andluck.com", "idea-b", "/api"),
  );
  assert.deepEqual(
    resolve("demo.s.andluck.com"),
    row("*.s.andluck.com", "demo"),
  );
  assert.deepEqual(
    resolve("http://localhost/red"),
    row("localhost", "", "/red", true),
  );
  assert.equal(resolve("a.b.andluck.com"), null);
  assert.equal(resolve("shop.example.com"), null);
});

test("an exact Domain row wins over the wildcard", () => {
  const withWww = [...domains, { id: 5, hostname: "www.andluck.com" }];
  const match = resolveRouteHost("www.andluck.com", withWww);
  assert.equal(match?.domain.id, 5);
  assert.equal(match?.subdomain, "");
});

test("parseRouteString normalizes case, trailing dots and slashes", () => {
  assert.deepEqual(parseRouteString(" HTTPS://Idea-A.AndLuck.com./Blog/ "), {
    host: "idea-a.andluck.com",
    pathPrefix: "/Blog",
    httpOnly: false,
  });
  assert.deepEqual(parseRouteString("andluck.com/"), {
    host: "andluck.com",
    pathPrefix: "",
    httpOnly: false,
  });
  assert.deepEqual(parseRouteString("andluck.com//a//b"), {
    host: "andluck.com",
    pathPrefix: "/a/b",
    httpOnly: false,
  });
});

test("parseRouteString rejects things it can't route", () => {
  for (const bad of [
    "",
    "ftp://andluck.com",
    "andluck.com:8080",
    "*.andluck.com",
    "andluck.com/a?b=1",
    "andluck.com/#x",
    "andluck.com/a b",
    "andluck.com/../x",
    "-bad.andluck.com",
  ]) {
    assert.throws(() => parseRouteString(bad), RouteStringError, bad);
  }
});

test("formatRouteString round-trips through the resolver", () => {
  const cases = [
    {
      domain: domains[1],
      subdomain: "idea-a",
      pathPrefix: "",
      httpOnly: false,
    },
    { domain: domains[0], subdomain: "", pathPrefix: "/api", httpOnly: false },
    { domain: domains[3], subdomain: "", pathPrefix: "/red", httpOnly: true },
  ];
  assert.deepEqual(cases.map(formatRouteString), [
    "idea-a.andluck.com",
    "andluck.com/api",
    "http://localhost/red",
  ]);
  for (const c of cases) {
    const parsed = parseRouteString(formatRouteString(c)!);
    const match = resolveRouteHost(parsed.host, domains);
    assert.equal(match?.domain.id, c.domain.id);
    assert.equal(match?.subdomain, c.subdomain);
    assert.equal(parsed.pathPrefix, c.pathPrefix);
    assert.equal(parsed.httpOnly, c.httpOnly);
  }
  assert.equal(
    formatRouteString({
      domain: null,
      subdomain: "",
      pathPrefix: "",
      httpOnly: false,
    }),
    null,
  );
});
