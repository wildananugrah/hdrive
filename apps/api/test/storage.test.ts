import { beforeEach, expect, test } from "bun:test";
import { s3Backend } from "../src/storage/s3.ts";
import {
  backendFor, createBackend, deleteBackend, invalidateBackendCache, listBackends,
  probeBackend, setWriteTarget, updateBackend, writeTarget,
} from "../src/backends.ts";
import { sql, uuids } from "../src/db.ts";
import { createSpace } from "../src/spaces.ts";
import { devConfig, makeUser, resetDb, withServer } from "./helpers.ts";

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

test("credentials are encrypted at rest, decrypt only with the right key, and round-trip", async () => {
  const created = await createBackend({ name: "primary", config: devConfig, makeWriteTarget: true });
  const [raw] = await sql`SELECT config FROM storage_backends WHERE id = ${created.id}`;
  const blob = Buffer.from(raw.config).toString("utf8");
  expect(blob).not.toContain(devConfig.secretAccessKey); // cheap sanity check, not the real proof

  // The real proof: the WRONG key must not recover the config (any encoding
  // that isn't real encryption — base64, hex, ... — would fail this too, since
  // pgp_sym_decrypt rejects anything that isn't its own ciphertext).
  await expect(Promise.resolve(
    sql`SELECT pgp_sym_decrypt(config, 'not-the-real-key') AS c FROM storage_backends WHERE id = ${created.id}`,
  )).rejects.toBeTruthy();

  // ...and the RIGHT key must round-trip the exact original config.
  const [dec] = await sql`SELECT pgp_sym_decrypt(config, ${process.env.STORAGE_CONFIG_KEY})::text AS c
                            FROM storage_backends WHERE id = ${created.id}`;
  expect(JSON.parse(dec.c)).toEqual(devConfig);

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

test("head rejects rather than returning null when credentials are bad", async () => {
  const bad = s3Backend({ ...devConfig, secretAccessKey: "wrong-secret-value" });
  // A rejection, not a resolved null: an auth failure must not read as "file is gone".
  await expect(bad.head(`test/${crypto.randomUUID()}`)).rejects.toBeTruthy();
});

test("updateBackend changes name and config", async () => {
  const created = await createBackend({ name: "orig", config: devConfig });
  const renamed = await updateBackend(created.id, { name: "renamed" });
  expect(renamed.name).toBe("renamed");

  const rotated = { ...devConfig, accessKeyId: "hdrive-rotated" };
  await updateBackend(created.id, { config: rotated });
  const [row] = await sql`SELECT pgp_sym_decrypt(config, ${process.env.STORAGE_CONFIG_KEY})::text AS c
                            FROM storage_backends WHERE id = ${created.id}`;
  expect(JSON.parse(row.c)).toEqual(rotated);
});

test("updateBackend's own call site invalidates the cache: backendFor picks up the new config", async () => {
  const created = await createBackend({ name: "cache-site", config: devConfig });
  const credOf = (url: string) => new URL(url).searchParams.get("X-Amz-Credential")?.split("/")[0];

  const before = await backendFor(created.id); // populates the cache with the OLD config
  expect(credOf(before.presignPut("k", "text/plain"))).toBe(devConfig.accessKeyId);

  await updateBackend(created.id, { config: { ...devConfig, accessKeyId: "hdrive-rotated" } });

  const after = await backendFor(created.id);
  expect(after).not.toBe(before); // a stale cached instance would fail this
  expect(credOf(after.presignPut("k", "text/plain"))).toBe("hdrive-rotated");
});

test("deleteBackend refuses while an item points here, and succeeds once none do", async () => {
  const backend = await createBackend({ name: "d", config: devConfig });
  const user = await makeUser();
  const space = await createSpace(user as any, "S");
  const itemId = crypto.randomUUID();
  await sql`
    INSERT INTO items (id, space_id, parent_id, kind, name, path_ids, storage_backend_id, storage_key, created_by, status)
    VALUES (${itemId}, ${space.id}, NULL, 'file', 'f.txt', ${uuids([itemId])}::uuid[], ${backend.id}, 'k', ${user.id}, 'ready')`;

  await expect(deleteBackend(backend.id)).rejects.toMatchObject({ status: 409 });

  await sql`DELETE FROM items WHERE id = ${itemId}`;
  await deleteBackend(backend.id); // now succeeds
  const left: unknown[] = await sql`SELECT id FROM storage_backends WHERE id = ${backend.id}`;
  expect(left).toEqual([]);
});

test("updateBackend is all-or-nothing: a bad config leaves the name alone", async () => {
  const created = await createBackend({ name: "original", config: devConfig });
  await expect(
    updateBackend(created.id, { name: "renamed", config: { ...devConfig, bucket: "" } }),
  ).rejects.toMatchObject({ status: 400 });
  const [row] = await sql`SELECT name FROM storage_backends WHERE id = ${created.id}`;
  expect(row.name).toBe("original");
});

test("updateBackend 404s on an unknown id without writing anything", async () => {
  await expect(updateBackend(crypto.randomUUID(), { name: "ghost" })).rejects.toMatchObject({ status: 404 });
});

test("deleteBackend racing an item that points here answers 409, never an unhandled FK error", async () => {
  const backend = await createBackend({ name: "raced", config: devConfig });
  const user = await makeUser();
  const space = await createSpace(user as any, "S");
  const itemId = crypto.randomUUID();

  // An open transaction that has inserted an item pointing at this backend:
  // invisible to a count taken outside it, but its FK row lock is real. This is
  // the exact interleaving a concurrent beginUpload produces.
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const holder = sql.begin(async (tx: any) => {
    await tx`
      INSERT INTO items (id, space_id, parent_id, kind, name, path_ids, storage_backend_id, storage_key, created_by, status)
      VALUES (${itemId}, ${space.id}, NULL, 'file', 'f.txt', ${uuids([itemId])}::uuid[], ${backend.id}, 'k', ${user.id}, 'pending')`;
    await gate;
  });

  await Bun.sleep(100);
  const del = deleteBackend(backend.id).then(() => "deleted" as const).catch((e) => e);
  await Bun.sleep(100);
  release();
  await holder;

  // 409, not a bare Postgres 23503 surfacing as a 500
  expect(await del).toMatchObject({ status: 409 });
  const [still] = await sql`SELECT id FROM storage_backends WHERE id = ${backend.id}`;
  expect(still?.id).toBe(backend.id);
});

test("deleteBackend on an unknown id returns 404, not a silent success", async () => {
  await expect(deleteBackend(crypto.randomUUID())).rejects.toMatchObject({ status: 404 });
});

test("probeBackend on an unknown id returns 404, not a 500", async () => {
  await expect(probeBackend(crypto.randomUUID())).rejects.toMatchObject({ status: 404 });
});

test("a non-string backend name returns 400 over HTTP, not 500", async () => {
  await withServer(async (base) => {
    const admin = await makeUser({ admin: true });
    const res = await fetch(`${base}/api/admin/backends`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({ name: 123, config: devConfig }),
    });
    expect(res.status).toBe(400);
  });
});
