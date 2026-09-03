import { beforeEach, expect, test } from "bun:test";
import { s3Backend } from "../src/storage/s3.ts";
import {
  backendFor, createBackend, invalidateBackendCache, listBackends,
  probeBackend, setWriteTarget, writeTarget,
} from "../src/backends.ts";
import { sql } from "../src/db.ts";
import { devConfig, resetDb } from "./helpers.ts";

beforeEach(async () => { await resetDb(); invalidateBackendCache(); });

test("presigned PUT uploads, and head reports the real size", async () => {
  const b = s3Backend(devConfig);
  const key = `test/${crypto.randomUUID()}`;
  const body = "hello hdrive range test payload";
  const res = await fetch(b.presignPut(key, "text/plain"), {
    method: "PUT", body, headers: { "content-type": "text/plain" },
  });
  expect(res.status).toBe(200);
  const h = await b.head(key);
  expect(h?.size).toBe(body.length);
  await b.delete(key);
});

test("head returns null for a missing key", async () => {
  expect(await s3Backend(devConfig).head(`test/${crypto.randomUUID()}`)).toBeNull();
});

test("delete is idempotent", async () => {
  await s3Backend(devConfig).delete(`test/${crypto.randomUUID()}`); // must not throw
});

test("getStream without a range returns the whole object", async () => {
  const b = s3Backend(devConfig);
  const key = `test/${crypto.randomUUID()}`;
  await fetch(b.presignPut(key, "text/plain"), { method: "PUT", body: "0123456789" });
  const r = await b.getStream(key);
  expect(r.status).toBe(200);
  expect(r.headers.get("accept-ranges")).toBe("bytes");
  expect(await r.text()).toBe("0123456789");
  await b.delete(key);
});

test("getStream honours a byte range with an inclusive end", async () => {
  const b = s3Backend(devConfig);
  const key = `test/${crypto.randomUUID()}`;
  await fetch(b.presignPut(key, "text/plain"), { method: "PUT", body: "0123456789" });

  const r = await b.getStream(key, "bytes=2-5");
  expect(r.status).toBe(206);
  expect(r.headers.get("content-range")).toBe("bytes 2-5/10");
  expect(r.headers.get("content-length")).toBe("4");
  expect(await r.text()).toBe("2345"); // inclusive: 2,3,4,5

  const open = await b.getStream(key, "bytes=7-");
  expect(await open.text()).toBe("789");

  const suffix = await b.getStream(key, "bytes=-3");
  expect(suffix.headers.get("content-range")).toBe("bytes 7-9/10");
  expect(await suffix.text()).toBe("789");

  const past = await b.getStream(key, "bytes=50-60");
  expect(past.status).toBe(416);

  await b.delete(key);
});

test("credentials are encrypted at rest and never returned", async () => {
  const created = await createBackend({ name: "primary", config: devConfig, makeWriteTarget: true });
  const [raw] = await sql`SELECT config FROM storage_backends WHERE id = ${created.id}`;
  const blob = Buffer.from(raw.config).toString("utf8");
  expect(blob).not.toContain(devConfig.secretAccessKey);

  for (const b of await listBackends()) {
    expect(JSON.stringify(b)).not.toContain(devConfig.secretAccessKey);
  }
});

test("only one backend is the write target, and switching moves it", async () => {
  const a = await createBackend({ name: "a", config: devConfig, makeWriteTarget: true });
  const b = await createBackend({ name: "b", config: devConfig });
  expect((await writeTarget()).id).toBe(a.id);
  await setWriteTarget(b.id);
  expect((await writeTarget()).id).toBe(b.id);
  const [{ count }] = await sql`SELECT count(*)::int AS count FROM storage_backends WHERE is_write_target`;
  expect(count).toBe(1);
});

test("writeTarget fails loudly when nothing is configured", async () => {
  await expect(writeTarget()).rejects.toMatchObject({ status: 503 });
});

test("probe reports every step green against a good config", async () => {
  const created = await createBackend({ name: "p", config: devConfig, makeWriteTarget: true });
  const r = await probeBackend(created.id);
  expect(r.ok).toBe(true);
  expect(r.steps.map((s: any) => s.step)).toEqual(["presign+put", "head", "range-get", "delete"]);
});

test("probe reports failure for bad credentials without throwing", async () => {
  const created = await createBackend({
    name: "bad", config: { ...devConfig, secretAccessKey: "wrong-secret-value" },
  });
  const r = await probeBackend(created.id);
  expect(r.ok).toBe(false);
  expect(r.steps.some((s: any) => !s.ok)).toBe(true);
});

test("backendFor caches, and invalidation picks up a config change", async () => {
  const created = await createBackend({ name: "c", config: devConfig });
  const first = await backendFor(created.id);
  expect(await backendFor(created.id)).toBe(first); // same instance
  invalidateBackendCache(created.id);
  expect(await backendFor(created.id)).not.toBe(first);
});
