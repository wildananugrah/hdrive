import { expect, test } from "vitest";
import { computeVisibility, isLiveShare, visibilityFromFlags } from "../src/lib/visibility";
import type { Grant, ShareLink } from "../src/api/types";

const NOW = new Date("2026-09-03T12:00:00Z");
const grant = (): Grant => ({ subject_type: "user", subject_id: "u1", role: 1 });
const share = (over: Partial<ShareLink> = {}): ShareLink => ({
  id: "s1", mode: "view", expires_at: null, revoked_at: null,
  created_at: "2026-09-01T00:00:00Z", has_password: false, ...over,
});

test("no grants and no links is Space", () => {
  expect(computeVisibility({ grants: [], shares: [], now: NOW })).toBe("space");
});

test("any grant is Shared", () => {
  expect(computeVisibility({ grants: [grant()], shares: [], now: NOW })).toBe("shared");
});

test("a live link is Public", () => {
  expect(computeVisibility({ grants: [], shares: [share()], now: NOW })).toBe("public");
});

test("Public wins over Shared — the badge shows the broadest exposure", () => {
  expect(computeVisibility({ grants: [grant()], shares: [share()], now: NOW })).toBe("public");
});

test("an expired link does not make an item Public", () => {
  const expired = share({ expires_at: "2026-09-02T00:00:00Z" });
  expect(computeVisibility({ grants: [], shares: [expired], now: NOW })).toBe("space");
  expect(computeVisibility({ grants: [grant()], shares: [expired], now: NOW })).toBe("shared");
});

test("a revoked link does not make an item Public", () => {
  const revoked = share({ revoked_at: "2026-09-02T00:00:00Z" });
  expect(computeVisibility({ grants: [], shares: [revoked], now: NOW })).toBe("space");
});

test("a never-expiring link is live", () => {
  expect(isLiveShare(share({ expires_at: null }), NOW)).toBe(true);
});

test("a link expiring exactly now is not live", () => {
  expect(isLiveShare(share({ expires_at: NOW.toISOString() }), NOW)).toBe(false);
});

test("one live link among dead ones still makes it Public", () => {
  const shares = [share({ revoked_at: "2026-09-02T00:00:00Z" }), share({ id: "s2" })];
  expect(computeVisibility({ grants: [], shares, now: NOW })).toBe("public");
});

// ---- visibilityFromFlags (list rows) ----------------------------------

test("no flags is Space", () => {
  expect(visibilityFromFlags({ has_grants: false, has_live_share: false })).toBe("space");
});

test("has_grants alone is Shared", () => {
  expect(visibilityFromFlags({ has_grants: true, has_live_share: false })).toBe("shared");
});

test("has_live_share alone is Public", () => {
  expect(visibilityFromFlags({ has_grants: false, has_live_share: true })).toBe("public");
});

test("both flags set is Public — Public outranks Shared here too", () => {
  expect(visibilityFromFlags({ has_grants: true, has_live_share: true })).toBe("public");
});

// ---- Agreement: computeVisibility and visibilityFromFlags must never
// disagree, across all four flag combinations, since list rows and detail
// views must show the same tier for the same underlying state. ----------

test("computeVisibility and visibilityFromFlags agree across all flag combinations", () => {
  const cases: Array<{ grants: Grant[]; shares: ShareLink[]; has_grants: boolean; has_live_share: boolean }> = [
    { grants: [], shares: [], has_grants: false, has_live_share: false },
    { grants: [grant()], shares: [], has_grants: true, has_live_share: false },
    { grants: [], shares: [share()], has_grants: false, has_live_share: true },
    { grants: [grant()], shares: [share()], has_grants: true, has_live_share: true },
  ];
  for (const c of cases) {
    const fromFull = computeVisibility({ grants: c.grants, shares: c.shares, now: NOW });
    const fromFlags = visibilityFromFlags({ has_grants: c.has_grants, has_live_share: c.has_live_share });
    expect(fromFlags).toBe(fromFull);
  }
});
