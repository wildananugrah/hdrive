import { sql } from "./db.ts";
import { HttpError } from "./http.ts";
import type { StorageBackend } from "./storage/index.ts";
import { s3Backend, type S3Config } from "./storage/s3.ts";

const KEY = process.env.STORAGE_CONFIG_KEY;
if (!KEY) throw new Error("STORAGE_CONFIG_KEY is required");

/**
 * Instances are cached by backend id; they hold no per-request state.
 * ponytail: process-local cache, no TTL or cross-process invalidation channel.
 * With more than one API process, an admin rotating credentials leaves the
 * OTHER processes on a stale S3Client (revoked keys) until they restart.
 * Upgrade path: a TTL on cache entries, or a LISTEN/NOTIFY channel that calls
 * invalidateBackendCache() on every process when a backend is updated.
 */
const cache = new Map<string, StorageBackend>();

export function invalidateBackendCache(id?: string) {
  if (id) cache.delete(id);
  else cache.clear();
}

function checkConfig(c: Partial<S3Config>): S3Config {
  for (const f of ["endpoint", "bucket", "accessKeyId", "secretAccessKey"] as const) {
    if (!c?.[f]) throw new HttpError(400, `config.${f} is required`);
  }
  if (!/^https?:\/\//.test(c.endpoint!)) throw new HttpError(400, "config.endpoint must be an http(s) URL");
  return c as S3Config;
}

export async function createBackend(input: {
  name: string; config: Partial<S3Config>; makeWriteTarget?: boolean;
}) {
  if (!input.name?.trim()) throw new HttpError(400, "name is required");
  const cfg = checkConfig(input.config);
  // One transaction: a failed write-target switch must not leave an orphaned
  // backend row that was inserted but never became reachable.
  return await sql.begin(async (tx: any) => {
    const [row] = await tx`
      INSERT INTO storage_backends (name, provider, config)
      VALUES (${input.name.trim()}, 's3', pgp_sym_encrypt(${JSON.stringify(cfg)}, ${KEY}))
      RETURNING id, name, provider, is_write_target, created_at`;
    if (input.makeWriteTarget) {
      await clearAndSetWriteTarget(tx, row.id);
      row.is_write_target = true;
    }
    return row;
  });
}

/** Never returns config: credentials do not leave the server, even for admins. */
export async function listBackends() {
  return await sql`
    SELECT b.id, b.name, b.provider, b.is_write_target, b.created_at,
           (SELECT count(*)::int FROM items i WHERE i.storage_backend_id = b.id) AS item_count
      FROM storage_backends b ORDER BY b.created_at`;
}

export async function updateBackend(id: string, patch: { name?: string; config?: Partial<S3Config> }) {
  if (patch.name !== undefined) {
    if (!patch.name.trim()) throw new HttpError(400, "name is required");
    await sql`UPDATE storage_backends SET name = ${patch.name.trim()} WHERE id = ${id}`;
  }
  if (patch.config !== undefined) {
    const cfg = checkConfig(patch.config);
    await sql`UPDATE storage_backends
                 SET config = pgp_sym_encrypt(${JSON.stringify(cfg)}, ${KEY})
               WHERE id = ${id}`;
  }
  invalidateBackendCache(id);
  const [row] = await sql`SELECT id, name, provider, is_write_target, created_at
                            FROM storage_backends WHERE id = ${id}`;
  if (!row) throw new HttpError(404, "backend not found");
  return row;
}

/**
 * Refuses while any item still points here. Deleting a backend that owns bytes
 * would orphan files that users can still see in their tree.
 */
export async function deleteBackend(id: string) {
  const [{ count }] = await sql`SELECT count(*)::int AS count FROM items WHERE storage_backend_id = ${id}`;
  if (count > 0) throw new HttpError(409, `${count} file(s) still stored here; cannot delete this backend`);
  const [row] = await sql`DELETE FROM storage_backends WHERE id = ${id} RETURNING id`;
  if (!row) throw new HttpError(404, "backend not found");
  invalidateBackendCache(id);
}

/** Shared by setWriteTarget and createBackend({ makeWriteTarget: true }) so both run inside one transaction. */
async function clearAndSetWriteTarget(tx: any, id: string) {
  await tx`UPDATE storage_backends SET is_write_target = false WHERE is_write_target`;
  await tx`UPDATE storage_backends SET is_write_target = true WHERE id = ${id}`;
}

/**
 * A partial unique index allows only one row with is_write_target, so the old
 * target must be cleared before the new one is set — in one transaction.
 */
export async function setWriteTarget(id: string) {
  await sql.begin(async (tx: any) => {
    const [exists] = await tx`SELECT 1 FROM storage_backends WHERE id = ${id}`;
    if (!exists) throw new HttpError(404, "backend not found");
    await clearAndSetWriteTarget(tx, id);
  });
}

export async function backendFor(id: string): Promise<StorageBackend> {
  const hit = cache.get(id);
  if (hit) return hit;
  const [row] = await sql`SELECT pgp_sym_decrypt(config, ${KEY})::text AS config
                            FROM storage_backends WHERE id = ${id}`;
  if (!row) throw new HttpError(500, "storage backend is missing for an existing file");
  const b = s3Backend(JSON.parse(row.config) as S3Config);
  cache.set(id, b);
  return b;
}

export async function writeTarget(): Promise<{ id: string; backend: StorageBackend }> {
  const [row] = await sql`SELECT id FROM storage_backends WHERE is_write_target LIMIT 1`;
  if (!row) throw new HttpError(503, "no storage backend is configured for uploads");
  return { id: row.id, backend: await backendFor(row.id) };
}

/**
 * A real put -> head -> range-get -> delete against a probe key.
 *
 * S3-compatible providers differ in ways that only show up in traffic:
 * path-style vs virtual-hosted addressing, CORS, presign clock skew. Surfacing
 * that when an admin saves the backend beats discovering it on a user's first
 * upload. Never throws: a failed step is the result.
 */
export async function probeBackend(id: string) {
  const [exists] = await sql`SELECT 1 FROM storage_backends WHERE id = ${id}`;
  if (!exists) throw new HttpError(404, "backend not found");
  const b = await backendFor(id);
  const key = `__hdrive_probe/${crypto.randomUUID()}`;
  const probeBody = "hdrive-probe";
  const steps: { step: string; ok: boolean; detail?: string }[] = [];

  const run = async (step: string, fn: () => Promise<void>) => {
    try { await fn(); steps.push({ step, ok: true }); return true; }
    catch (e: any) { steps.push({ step, ok: false, detail: String(e?.message ?? e).slice(0, 200) }); return false; }
  };

  const ok1 = await run("presign+put", async () => {
    const r = await fetch(b.presignPut(key, "text/plain", 120), {
      method: "PUT", body: probeBody, headers: { "content-type": "text/plain" },
    });
    if (!r.ok) throw new Error(`PUT returned ${r.status}`);
  });
  if (ok1) {
    await run("head", async () => {
      const h = await b.head(key);
      if (!h) throw new Error("object not found after a successful PUT");
    });
    await run("range-get", async () => {
      const r = await b.getStream(key, "bytes=0-3");
      if (r.status !== 206) throw new Error(`expected 206, got ${r.status}`);
      // Not just the status: a backend that ignores Range and returns the
      // whole object would still be 206-shaped-enough to fool a status check.
      const text = await r.text();
      const expected = probeBody.slice(0, 4);
      if (text !== expected) throw new Error(`expected slice ${JSON.stringify(expected)}, got ${JSON.stringify(text)}`);
    });
    await run("delete", () => b.delete(key));
  }
  return { ok: steps.length > 0 && steps.every((s) => s.ok), steps };
}
