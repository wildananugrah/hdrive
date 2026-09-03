import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../src/api/client";
import { ApiError, isConflict, isForbidden, isNotFound, isUnauthorized, isUnavailable } from "../src/api/errors";

const mockFetch = (status: number, body: unknown, headers: Record<string,string> = {}) =>
  vi.fn().mockResolvedValue(
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    }),
  );

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); });

test("GET returns parsed JSON", async () => {
  vi.stubGlobal("fetch", mockFetch(200, { id: "x" }));
  expect(await api.get<{ id: string }>("/api/items/x")).toEqual({ id: "x" });
});

test("every request sends credentials, so the session cookie travels", async () => {
  const f = mockFetch(200, {});
  vi.stubGlobal("fetch", f);
  await api.get("/api/auth/me");
  expect(f.mock.calls[0][1].credentials).toBe("include");
});

test("a 204 resolves to null rather than failing to parse", async () => {
  // Real DELETE responses carry an application/json content-type even with an
  // empty body, so this must exercise the isJson path, not skip it for free.
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    new Response(null, { status: 204, headers: { "content-type": "application/json" } }),
  ));
  expect(await api.del("/api/shares/abc")).toBeNull();
});

test("an error status becomes a typed ApiError carrying the API's message", async () => {
  vi.stubGlobal("fetch", mockFetch(409, { error: "an item with that name already exists here" }));
  const err = await api.post("/api/spaces/s/folders", { name: "x" }).catch((e) => e) as ApiError;
  expect(err).toBeInstanceOf(ApiError);
  expect(err.status).toBe(409);
  expect(err.message).toBe("an item with that name already exists here");
  expect(isConflict(err)).toBe(true);
});

test("guards distinguish the statuses the UI branches on", async () => {
  const table = [
    [401, isUnauthorized],
    [403, isForbidden],
    [404, isNotFound],
    [409, isConflict],
    [503, isUnavailable],
  ] as const;
  for (const [status, guard] of table) {
    vi.stubGlobal("fetch", mockFetch(status, { error: "nope" }));
    const e = await api.get("/api/items/x").catch((x) => x) as ApiError;
    expect(guard(e)).toBe(true);
    // Every other guard must reject this status, so a swapped status code
    // (e.g. isForbidden checking 503 instead of 403) cannot pass silently.
    for (const [, otherGuard] of table) {
      if (otherGuard !== guard) expect(otherGuard(e)).toBe(false);
    }
  }
});

test("a non-JSON error body still produces an ApiError with the status", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    new Response("<html>502</html>", { status: 502, headers: { "content-type": "text/html" } }),
  ));
  const e = await api.get("/api/health").catch((x) => x) as ApiError;
  expect(e).toBeInstanceOf(ApiError);
  expect(e.status).toBe(502);
});

test("a network failure surfaces as an ApiError, not a raw TypeError", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
  const e = await api.get("/api/health").catch((x) => x) as ApiError;
  expect(e).toBeInstanceOf(ApiError);
  expect(e.status).toBe(0);
});
