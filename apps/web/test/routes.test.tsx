import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
// Same rationale as test/tokens.test.ts: resolve the path with node:path so a
// plain file read works under vitest.
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(join(here, "../src/App.tsx"), "utf8");

// nginx proxies the whole /s/ prefix to the API's public share endpoints
// (GET /s/:token, POST /s/:token/unlock). A client-side route under /s/
// collides with that prefix and 404s in production (see the 2026-09-03
// route-collision hotfix). Space routes live under /space/ instead; this
// pins the separation so it cannot silently come back.
const routePaths = [...appSrc.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]);

test("space routes are declared under /space/, not /s/", () => {
  const spaceRoutes = routePaths.filter((p) => p.includes(":spaceId"));
  expect(spaceRoutes.length).toBeGreaterThan(0);
  for (const p of spaceRoutes) expect(p).toMatch(/^\/space\//);
});

test("no client-side route lives under the API's /s/ share prefix", () => {
  for (const p of routePaths) expect(p).not.toMatch(/^\/s(\/|$)/);
});

test("the public share route is untouched at /share/:token", () => {
  expect(routePaths).toContain("/share/:token");
});
