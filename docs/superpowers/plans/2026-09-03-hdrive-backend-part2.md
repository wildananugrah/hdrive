# Hdrive Backend Implementation Plan — Part 2 (Tasks 4–9)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Continues:** `docs/superpowers/plans/2026-09-03-hdrive-backend.md` (tasks 1–3).
**Spec:** `docs/superpowers/specs/2026-09-03-hdrive-design.md`

Part 1's **Global Constraints** and **Verified Environment Facts** apply to every task here. Re-read them before starting — especially the `uuids()` / `parseUuids()` rules and the `slice(start, end + 1)` off-by-one.

---

### Task 4: Items — folders, listing, rename, move

**Files:**
- Create: `apps/api/src/items.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/test/items.test.ts`

**Interfaces:**
- Consumes: `sql`, `uuids`, `parseUuids`; `HttpError`; `User`; `Item`, `EDITOR`, `VIEWER`, `OWNER`, `requireItem`, `requireSpace` from `perm.ts`.
- Produces: `checkName(name)`, `createFolder(user, spaceId, parentId, name): Promise<Item>`, `listChildren(user, spaceId, parentId): Promise<Item[]>`, `renameItem(user, itemId, name)`, `moveItem(user, itemId, newParentId)`, `getItem(user, itemId): Promise<Item>`

- [ ] **Step 1: Write the failing test** — `apps/api/test/items.test.ts`

```ts
import { beforeEach, expect, test } from "bun:test";
import { parseUuids, sql } from "../src/db.ts";
import { EDITOR, VIEWER, requireItem } from "../src/perm.ts";
import { createFolder, listChildren, moveItem, renameItem } from "../src/items.ts";
import { addSpaceMember, createSpace } from "../src/spaces.ts";
import { makeUser, resetDb } from "./helpers.ts";

beforeEach(resetDb);

async function setup() {
  const owner = await makeUser();
  const space = await createSpace(owner as any, "S");
  return { owner, spaceId: space.id };
}

test("a root folder's path_ids is exactly [its own id]", async () => {
  const { owner, spaceId } = await setup();
  const f = await createFolder(owner as any, spaceId, null, "root");
  expect(f.path_ids).toEqual([f.id]);
  expect(f.parent_id).toBeNull();
});

test("a nested folder's path_ids is ancestors + self", async () => {
  const { owner, spaceId } = await setup();
  const a = await createFolder(owner as any, spaceId, null, "a");
  const b = await createFolder(owner as any, spaceId, a.id, "b");
  const c = await createFolder(owner as any, spaceId, b.id, "c");
  expect(c.path_ids).toEqual([a.id, b.id, c.id]);
});

test("creating a folder requires EDITOR on the parent", async () => {
  const { owner, spaceId } = await setup();
  const a = await createFolder(owner as any, spaceId, null, "a");
  const viewer = await makeUser();
  await addSpaceMember(owner as any, spaceId, { type: "user", id: viewer.id }, VIEWER);
  await expect(createFolder(viewer as any, spaceId, a.id, "b")).rejects.toMatchObject({ status: 403 });
});

test("rejects invalid names", async () => {
  const { owner, spaceId } = await setup();
  for (const bad of ["", "   ", "a/b", "..", ".", String.fromCharCode(97, 0, 98), "x".repeat(256)]) {
    await expect(createFolder(owner as any, spaceId, null, bad)).rejects.toMatchObject({ status: 400 });
  }
});

test("rejects a duplicate sibling name, case-insensitively", async () => {
  const { owner, spaceId } = await setup();
  await createFolder(owner as any, spaceId, null, "Docs");
  await expect(createFolder(owner as any, spaceId, null, "docs")).rejects.toMatchObject({ status: 409 });
});

test("the same name is fine in different folders", async () => {
  const { owner, spaceId } = await setup();
  const a = await createFolder(owner as any, spaceId, null, "a");
  const b = await createFolder(owner as any, spaceId, null, "b");
  await createFolder(owner as any, spaceId, a.id, "same");
  await createFolder(owner as any, spaceId, b.id, "same"); // must not throw
});

test("listChildren returns only direct children the caller can see", async () => {
  const { owner, spaceId } = await setup();
  const a = await createFolder(owner as any, spaceId, null, "a");
  await createFolder(owner as any, spaceId, a.id, "child1");
  await createFolder(owner as any, spaceId, a.id, "child2");
  await createFolder(owner as any, spaceId, null, "sibling");
  const kids = await listChildren(owner as any, spaceId, a.id);
  expect(kids.map((k: any) => k.name).sort()).toEqual(["child1", "child2"]);
});

test("moving a folder rewrites path_ids for the whole subtree", async () => {
  const { owner, spaceId } = await setup();
  const a = await createFolder(owner as any, spaceId, null, "a");
  const b = await createFolder(owner as any, spaceId, a.id, "b");
  const c = await createFolder(owner as any, spaceId, b.id, "c");
  const d = await createFolder(owner as any, spaceId, null, "d");

  await moveItem(owner as any, b.id, d.id);

  const after = async (id: string) =>
    parseUuids((await sql`SELECT path_ids FROM items WHERE id = ${id}`)[0].path_ids);

  expect(await after(b.id)).toEqual([d.id, b.id]);
  expect(await after(c.id)).toEqual([d.id, b.id, c.id]);
  expect(await after(a.id)).toEqual([a.id]);   // untouched
  expect(await after(d.id)).toEqual([d.id]);   // untouched
});

test("moving to the root produces a one-element path", async () => {
  const { owner, spaceId } = await setup();
  const a = await createFolder(owner as any, spaceId, null, "a");
  const b = await createFolder(owner as any, spaceId, a.id, "b");
  await moveItem(owner as any, b.id, null);
  const [row] = await sql`SELECT path_ids, parent_id FROM items WHERE id = ${b.id}`;
  expect(parseUuids(row.path_ids)).toEqual([b.id]);
  expect(row.parent_id).toBeNull();
});

test("a folder cannot be moved into itself or its own descendant", async () => {
  const { owner, spaceId } = await setup();
  const a = await createFolder(owner as any, spaceId, null, "a");
  const b = await createFolder(owner as any, spaceId, a.id, "b");
  await expect(moveItem(owner as any, a.id, a.id)).rejects.toMatchObject({ status: 400 });
  await expect(moveItem(owner as any, a.id, b.id)).rejects.toMatchObject({ status: 400 });
});

test("an inherited grant still resolves after a move", async () => {
  const { owner, spaceId } = await setup();
  const a = await createFolder(owner as any, spaceId, null, "a");
  const b = await createFolder(owner as any, spaceId, a.id, "b");
  const d = await createFolder(owner as any, spaceId, null, "d");

  const guest = await makeUser();
  await sql`INSERT INTO item_grants (item_id, subject_type, subject_id, role)
            VALUES (${d.id}, 'user', ${guest.id}, ${EDITOR})`;

  // before the move, guest cannot see b
  await expect(requireItem(guest.id, b.id, VIEWER)).rejects.toMatchObject({ status: 404 });
  await moveItem(owner as any, b.id, d.id);
  // after moving under d, d's grant now covers b
  const it = await requireItem(guest.id, b.id, VIEWER);
  expect(it.id).toBe(b.id);
});

test("rename rejects a name that collides with a sibling", async () => {
  const { owner, spaceId } = await setup();
  await createFolder(owner as any, spaceId, null, "a");
  const b = await createFolder(owner as any, spaceId, null, "b");
  await expect(renameItem(owner as any, b.id, "A")).rejects.toMatchObject({ status: 409 });
  await renameItem(owner as any, b.id, "bb"); // must not throw
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && bun test test/items.test.ts`
Expected: FAIL — cannot resolve `../src/items.ts`.

- [ ] **Step 3: Write `apps/api/src/items.ts`**

```ts
import { parseUuids, sql, uuids } from "./db.ts";
import { HttpError } from "./http.ts";
import type { User } from "./auth.ts";
import { EDITOR, VIEWER, type Item, requireItem, requireSpace } from "./perm.ts";

/** Names are user-visible and become Content-Disposition filenames. Keep them boring. */
export function checkName(name: string): string {
  const n = (name ?? "").trim();
  if (!n) throw new HttpError(400, "name is required");
  if (n.length > 255) throw new HttpError(400, "name must be 255 characters or fewer");
  if (n === "." || n === "..") throw new HttpError(400, "invalid name");
  if (/[/\\]/.test(n)) throw new HttpError(400, "name may not contain slashes");
  if ([...n].some((ch) => ch.codePointAt(0)! < 0x20 || ch.codePointAt(0) === 0x7f))
    throw new HttpError(400, "name may not contain control characters");
  return n;
}

/** Unique sibling-name violations come back as 23505 from items_sibling_name. */
function asConflict(e: any): never {
  if (e?.errno === "23505") throw new HttpError(409, "an item with that name already exists here");
  throw e;
}

async function parentPathFor(user: User, spaceId: string, parentId: string | null): Promise<string[]> {
  if (!parentId) {
    await requireSpace(user.id, spaceId, EDITOR);
    return [];
  }
  const parent = await requireItem(user.id, parentId, EDITOR);
  if (parent.kind !== "folder") throw new HttpError(400, "parent is not a folder");
  if (parent.space_id !== spaceId) throw new HttpError(400, "parent is in a different space");
  return parent.path_ids;
}

export async function createFolder(
  user: User, spaceId: string, parentId: string | null, name: string,
): Promise<Item> {
  const n = checkName(name);
  const parentPath = await parentPathFor(user, spaceId, parentId);
  // The id is generated here so path_ids can include self in a single INSERT.
  const id = crypto.randomUUID();
  try {
    const [row] = await sql`
      INSERT INTO items (id, space_id, parent_id, kind, name, path_ids, created_by, status)
      VALUES (${id}, ${spaceId}, ${parentId}, 'folder', ${n},
              ${uuids([...parentPath, id])}::uuid[], ${user.id}, 'ready')
      RETURNING *`;
    return { ...row, path_ids: parseUuids(row.path_ids) } as Item;
  } catch (e) { asConflict(e); }
}

export async function getItem(user: User, itemId: string): Promise<Item> {
  return await requireItem(user.id, itemId, VIEWER);
}

export async function listChildren(user: User, spaceId: string, parentId: string | null) {
  if (parentId) await requireItem(user.id, parentId, VIEWER);
  else await requireSpace(user.id, spaceId, VIEWER);

  const rows = parentId
    ? await sql`SELECT * FROM items
                 WHERE parent_id = ${parentId} AND deleted_at IS NULL AND status = 'ready'
                 ORDER BY kind DESC, lower(name)`
    : await sql`SELECT * FROM items
                 WHERE space_id = ${spaceId} AND parent_id IS NULL
                   AND deleted_at IS NULL AND status = 'ready'
                 ORDER BY kind DESC, lower(name)`;

  return rows.map((r: any) => ({
    ...r, path_ids: parseUuids(r.path_ids), size: r.size === null ? null : Number(r.size),
  })) as Item[];
}

export async function renameItem(user: User, itemId: string, name: string) {
  const n = checkName(name);
  await requireItem(user.id, itemId, EDITOR);
  try {
    const [row] = await sql`UPDATE items SET name = ${n} WHERE id = ${itemId} RETURNING *`;
    return { ...row, path_ids: parseUuids(row.path_ids) } as Item;
  } catch (e) { asConflict(e); }
}

/**
 * Moves an item and rewrites path_ids for its entire subtree.
 *
 * This is the ONLY place path_ids is mutated. The rewrite replaces the first
 * `depth` elements (the old ancestor chain plus the item itself) with the new
 * ancestor chain, keeping each descendant's own tail intact:
 *
 *   new = newAncestors || old[depth:]
 *
 * For the moved item itself old[depth:] is [item]; for a descendant it is
 * [item, ...rest]. Postgres arrays are 1-indexed, so old[depth:] starts at the
 * item's own position.
 */
export async function moveItem(user: User, itemId: string, newParentId: string | null) {
  const item = await requireItem(user.id, itemId, EDITOR);

  let newAncestors: string[];
  if (newParentId) {
    if (newParentId === itemId) throw new HttpError(400, "cannot move an item into itself");
    const parent = await requireItem(user.id, newParentId, EDITOR);
    if (parent.kind !== "folder") throw new HttpError(400, "target is not a folder");
    if (parent.space_id !== item.space_id) throw new HttpError(400, "cross-space moves are not supported");
    // If the target's own path contains this item, the target is a descendant.
    if (parent.path_ids.includes(itemId)) throw new HttpError(400, "cannot move a folder into its own descendant");
    newAncestors = parent.path_ids;
  } else {
    await requireSpace(user.id, item.space_id, EDITOR);
    newAncestors = [];
  }

  const depth = item.path_ids.length;
  try {
    await sql.begin(async (tx: any) => {
      await tx`UPDATE items SET parent_id = ${newParentId} WHERE id = ${itemId}`;
      await tx`UPDATE items
                  SET path_ids = ${uuids(newAncestors)}::uuid[] || path_ids[${depth}:]
                WHERE path_ids @> ARRAY[${itemId}]::uuid[]`;
    });
  } catch (e) { asConflict(e); }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && bun test test/items.test.ts`
Expected: 12 pass.

- [ ] **Step 5: Add routes to `apps/api/src/server.ts`**

```ts
import { createFolder, getItem, listChildren, moveItem, renameItem } from "./items.ts";
```

```ts
  "/api/spaces/:id/children": {
    GET: route(async (req) => {
      const u = await requireUser(req);
      const parent = new URL(req.url).searchParams.get("parent");
      return json(await listChildren(u, req.params.id, parent));
    }),
  },

  "/api/spaces/:id/folders": {
    POST: route(async (req) => {
      const u = await requireUser(req);
      const b = await body<{ name: string; parent_id?: string | null }>(req);
      return json(await createFolder(u, req.params.id, b.parent_id ?? null, b.name), 201);
    }),
  },

  "/api/items/:id": {
    GET: route(async (req) => json(await getItem(await requireUser(req), req.params.id))),
    PATCH: route(async (req) => {
      const u = await requireUser(req);
      const b = await body<{ name?: string; parent_id?: string | null }>(req);
      if (b.name !== undefined) await renameItem(u, req.params.id, b.name);
      if (b.parent_id !== undefined) await moveItem(u, req.params.id, b.parent_id);
      return json(await getItem(u, req.params.id));
    }),
  },
```

- [ ] **Step 6: Run all tests, then commit**

Run: `cd apps/api && bun test`

```bash
git add apps/api
git commit -m "feat: folders, listing, rename, and subtree-safe move"
```

---

### Task 5: Storage backends — adapter, encryption, admin CRUD, probe

Gate for tasks 6–9. Requires MinIO running.

**Files:**
- Create: `apps/api/src/storage/index.ts`, `apps/api/src/storage/s3.ts`
- Create: `apps/api/src/backends.ts`
- Create: `apps/api/scripts/seed-admin.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/test/storage.test.ts`

**Interfaces:**
- Produces:
  - `storage/index.ts`: `interface StorageBackend { presignPut(key, mime, expiresIn?): string; getStream(key, range?): Promise<Response>; head(key): Promise<{size, mime} | null>; delete(key): Promise<void> }`
  - `storage/s3.ts`: `type S3Config`, `s3Backend(cfg): StorageBackend`
  - `backends.ts`: `createBackend(input)`, `listBackends()`, `updateBackend(id, patch)`, `deleteBackend(id)`, `setWriteTarget(id)`, `backendFor(id): Promise<StorageBackend>`, `writeTarget(): Promise<{ id, backend }>`, `probeBackend(id)`, `invalidateBackendCache(id?)`

- [ ] **Step 1: Write `apps/api/src/storage/index.ts`**

```ts
/**
 * The whole storage surface. Four methods, because Hdrive runs N configured
 * instances at once and every file remembers which one holds its bytes.
 */
export interface StorageBackend {
  /** Synchronous: Bun's presign() is not a promise. */
  presignPut(key: string, mime: string, expiresIn?: number): string;
  /** Passes an HTTP Range through; returns 206 when a range was requested. */
  getStream(key: string, range?: string | null): Promise<Response>;
  /** null means "no such object". Any other failure throws. */
  head(key: string): Promise<{ size: number; mime: string } | null>;
  /** Idempotent: deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
}
```

- [ ] **Step 2: Write `apps/api/src/storage/s3.ts`**

```ts
import { S3Client } from "bun";
import { HttpError } from "../http.ts";
import type { StorageBackend } from "./index.ts";

export type S3Config = {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  /** Most S3-compatible providers (MinIO included) need this false. */
  virtualHostedStyle?: boolean;
};

export function s3Backend(cfg: S3Config): StorageBackend {
  const c = new S3Client({
    endpoint: cfg.endpoint,
    bucket: cfg.bucket,
    region: cfg.region ?? "us-east-1",
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    virtualHostedStyle: cfg.virtualHostedStyle ?? false,
  });

  return {
    presignPut: (key, mime, expiresIn = 900) =>
      c.presign(key, { method: "PUT", type: mime, expiresIn }),

    head: async (key) => {
      try {
        const s = await c.stat(key);
        return { size: Number(s.size), mime: s.type || "application/octet-stream" };
      } catch (e: any) {
        // ONLY a genuine miss maps to null. Catching every S3Error would turn
        // an auth failure or a network fault into a silent "file is gone",
        // which the upload handshake would then report as a bad upload.
        if (e?.code === "NoSuchKey" || e?.code === "NotFound") return null;
        throw e;
      }
    },

    delete: async (key) => { await c.delete(key); },

    getStream: async (key, range) => {
      let stat;
      try {
        stat = await c.stat(key);
      } catch (e: any) {
        if (e?.code === "NoSuchKey" || e?.code === "NotFound")
          throw new HttpError(404, "object not found");
        throw e;
      }
      const total = Number(stat.size);
      const type = stat.type || "application/octet-stream";
      const f = c.file(key);

      const m = range?.match(/^bytes=(\d*)-(\d*)$/);
      if (!m) {
        return new Response(f.stream(), {
          headers: {
            "content-type": type,
            "content-length": String(total),
            "accept-ranges": "bytes",
          },
        });
      }

      let start: number;
      let end: number;
      if (m[1] === "") {
        // suffix range: "bytes=-500" means the LAST 500 bytes
        const n = Number(m[2]);
        if (!n) return rangeNotSatisfiable(total);
        start = Math.max(0, total - n);
        end = total - 1;
      } else {
        start = Number(m[1]);
        end = m[2] === "" ? total - 1 : Math.min(Number(m[2]), total - 1);
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total)
        return rangeNotSatisfiable(total);

      // HTTP Range end is INCLUSIVE; S3File.slice end is EXCLUSIVE.
      return new Response(f.slice(start, end + 1).stream(), {
        status: 206,
        headers: {
          "content-type": type,
          "content-length": String(end - start + 1),
          "content-range": `bytes ${start}-${end}/${total}`,
          "accept-ranges": "bytes",
        },
      });
    },
  };
}

const rangeNotSatisfiable = (total: number) =>
  new Response(null, { status: 416, headers: { "content-range": `bytes */${total}` } });
```

- [ ] **Step 3: Write the failing test** — `apps/api/test/storage.test.ts`

```ts
import { beforeEach, expect, test } from "bun:test";
import { s3Backend, type S3Config } from "../src/storage/s3.ts";
import {
  backendFor, createBackend, invalidateBackendCache, listBackends,
  probeBackend, setWriteTarget, writeTarget,
} from "../src/backends.ts";
import { sql } from "../src/db.ts";
import { resetDb } from "./helpers.ts";

export const devConfig: S3Config = {
  endpoint: process.env.DEV_S3_ENDPOINT!,
  bucket: process.env.DEV_S3_BUCKET!,
  accessKeyId: process.env.DEV_S3_KEY!,
  secretAccessKey: process.env.DEV_S3_SECRET!,
};

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
```

- [ ] **Step 4: Run to verify it fails**

Run: `cd apps/api && bun test test/storage.test.ts`
Expected: FAIL — cannot resolve `../src/backends.ts`.

- [ ] **Step 5: Write `apps/api/src/backends.ts`**

```ts
import { sql } from "./db.ts";
import { HttpError } from "./http.ts";
import type { StorageBackend } from "./storage/index.ts";
import { s3Backend, type S3Config } from "./storage/s3.ts";

const KEY = process.env.STORAGE_CONFIG_KEY;
if (!KEY) throw new Error("STORAGE_CONFIG_KEY is required");

/** Instances are cached by backend id; they hold no per-request state. */
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
  const [row] = await sql`
    INSERT INTO storage_backends (name, provider, config)
    VALUES (${input.name.trim()}, 's3', pgp_sym_encrypt(${JSON.stringify(cfg)}, ${KEY}))
    RETURNING id, name, provider, is_write_target, created_at`;
  if (input.makeWriteTarget) await setWriteTarget(row.id);
  return row;
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
  await sql`DELETE FROM storage_backends WHERE id = ${id}`;
  invalidateBackendCache(id);
}

/**
 * A partial unique index allows only one row with is_write_target, so the old
 * target must be cleared before the new one is set — in one transaction.
 */
export async function setWriteTarget(id: string) {
  await sql.begin(async (tx: any) => {
    const [exists] = await tx`SELECT 1 FROM storage_backends WHERE id = ${id}`;
    if (!exists) throw new HttpError(404, "backend not found");
    await tx`UPDATE storage_backends SET is_write_target = false WHERE is_write_target`;
    await tx`UPDATE storage_backends SET is_write_target = true WHERE id = ${id}`;
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
  const b = await backendFor(id);
  const key = `__hdrive_probe/${crypto.randomUUID()}`;
  const steps: { step: string; ok: boolean; detail?: string }[] = [];

  const run = async (step: string, fn: () => Promise<void>) => {
    try { await fn(); steps.push({ step, ok: true }); return true; }
    catch (e: any) { steps.push({ step, ok: false, detail: String(e?.message ?? e).slice(0, 200) }); return false; }
  };

  const ok1 = await run("presign+put", async () => {
    const r = await fetch(b.presignPut(key, "text/plain", 120), {
      method: "PUT", body: "hdrive-probe", headers: { "content-type": "text/plain" },
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
      await r.text();
    });
    await run("delete", () => b.delete(key));
  }
  return { ok: steps.length > 0 && steps.every((s) => s.ok), steps };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Requires MinIO up (`docker compose up -d`) and `.env` loaded — Bun reads `.env` automatically from the directory it runs in, so run from `apps/api` with the env vars present. If `DEV_S3_*` are unset, copy them from the repo root `.env`.

Run: `cd apps/api && bun test test/storage.test.ts`
Expected: 11 pass.

- [ ] **Step 7: Write `apps/api/scripts/seed-admin.ts`**

```ts
import { sql } from "../src/db.ts";
import { register } from "../src/auth.ts";

const [email, password, name] = process.argv.slice(2);
if (!email || !password) {
  console.error("usage: bun run seed:admin <email> <password> [name]");
  process.exit(1);
}

const [existing] = await sql`SELECT id FROM users WHERE email = ${email.toLowerCase()}`;
const id = existing?.id ?? (await register(email, password, name ?? "Admin")).id;
await sql`UPDATE users SET is_admin = true WHERE id = ${id}`;
console.log(`admin ready: ${email}`);
await sql.close();
```

- [ ] **Step 8: Add admin routes to `apps/api/src/server.ts`**

```ts
import {
  createBackend, deleteBackend, listBackends, probeBackend, setWriteTarget, updateBackend,
} from "./backends.ts";
```

```ts
  "/api/admin/backends": {
    GET: route(async (req) => { await requireAdmin(req); return json(await listBackends()); }),
    POST: route(async (req) => {
      await requireAdmin(req);
      const b = await body<any>(req);
      return json(await createBackend(b), 201);
    }),
  },

  "/api/admin/backends/:id": {
    PATCH: route(async (req) => {
      await requireAdmin(req);
      return json(await updateBackend(req.params.id, await body<any>(req)));
    }),
    DELETE: route(async (req) => {
      await requireAdmin(req);
      await deleteBackend(req.params.id);
      return new Response(null, { status: 204 });
    }),
  },

  "/api/admin/backends/:id/write-target": {
    POST: route(async (req) => {
      await requireAdmin(req);
      await setWriteTarget(req.params.id);
      return new Response(null, { status: 204 });
    }),
  },

  "/api/admin/backends/:id/probe": {
    POST: route(async (req) => {
      await requireAdmin(req);
      return json(await probeBackend(req.params.id));
    }),
  },
```

- [ ] **Step 9: Run all tests, then commit**

```bash
cd apps/api && bun test
git add apps/api
git commit -m "feat: pluggable S3 storage backends with encrypted config and a connection probe"
```

---

### Task 6: Upload handshake

**Files:**
- Create: `apps/api/src/upload.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/test/upload.test.ts`

**Interfaces:**
- Produces: `beginUpload(user, spaceId, parentId, name, mime): Promise<{ item_id, url, expires_in }>`, `completeUpload(user, itemId): Promise<Item>`

- [ ] **Step 1: Write the failing test** — `apps/api/test/upload.test.ts`

```ts
import { beforeEach, expect, test } from "bun:test";
import { sql } from "../src/db.ts";
import { createBackend, invalidateBackendCache, setWriteTarget } from "../src/backends.ts";
import { beginUpload, completeUpload } from "../src/upload.ts";
import { createSpace, addSpaceMember } from "../src/spaces.ts";
import { createFolder } from "../src/items.ts";
import { VIEWER } from "../src/perm.ts";
import { makeUser, resetDb } from "./helpers.ts";
import { devConfig } from "./storage.test.ts";

beforeEach(async () => { await resetDb(); invalidateBackendCache(); });

async function setup() {
  const owner = await makeUser();
  const space = await createSpace(owner as any, "S");
  const backend = await createBackend({ name: "primary", config: devConfig, makeWriteTarget: true });
  return { owner, spaceId: space.id, backendId: backend.id };
}

const upload = (url: string, body: string, type = "text/plain") =>
  fetch(url, { method: "PUT", body, headers: { "content-type": type } });

test("a full upload round-trip marks the file ready with the real size", async () => {
  const { owner, spaceId } = await setup();
  const { item_id, url } = await beginUpload(owner as any, spaceId, null, "notes.txt", "text/plain");

  const [pending] = await sql`SELECT status, size FROM items WHERE id = ${item_id}`;
  expect(pending.status).toBe("pending");
  expect(pending.size).toBeNull();

  expect((await upload(url, "twelve chars")).status).toBe(200);
  const done = await completeUpload(owner as any, item_id);
  expect(done.status).toBe("ready");
  expect(done.size).toBe(12);
});

test("complete fails when nothing was actually uploaded", async () => {
  const { owner, spaceId } = await setup();
  const { item_id } = await beginUpload(owner as any, spaceId, null, "ghost.txt", "text/plain");
  await expect(completeUpload(owner as any, item_id)).rejects.toMatchObject({ status: 400 });
  const [row] = await sql`SELECT status FROM items WHERE id = ${item_id}`;
  expect(row.status).toBe("pending");
});

test("size comes from storage, not from the client", async () => {
  const { owner, spaceId } = await setup();
  const { item_id, url } = await beginUpload(owner as any, spaceId, null, "real.txt", "text/plain");
  await upload(url, "actually-29-characters-long!!");
  // A client claiming something else must not win: completeUpload takes no size.
  const done = await completeUpload(owner as any, item_id);
  expect(done.size).toBe(29);
});

test("complete is idempotent", async () => {
  const { owner, spaceId } = await setup();
  const { item_id, url } = await beginUpload(owner as any, spaceId, null, "i.txt", "text/plain");
  await upload(url, "abc");
  const a = await completeUpload(owner as any, item_id);
  const b = await completeUpload(owner as any, item_id);
  expect(b.size).toBe(a.size);
  expect(b.status).toBe("ready");
});

test("upload requires EDITOR", async () => {
  const { owner, spaceId } = await setup();
  const viewer = await makeUser();
  await addSpaceMember(owner as any, spaceId, { type: "user", id: viewer.id }, VIEWER);
  await expect(
    beginUpload(viewer as any, spaceId, null, "x.txt", "text/plain"),
  ).rejects.toMatchObject({ status: 403 });
});

test("uploads land in the current write target, and old files keep their own", async () => {
  const { owner, spaceId, backendId: first } = await setup();

  const a = await beginUpload(owner as any, spaceId, null, "old.txt", "text/plain");
  await upload(a.url, "old");
  await completeUpload(owner as any, a.item_id);

  // Admin adds a second backend and switches the write target.
  const second = await createBackend({ name: "secondary", config: devConfig });
  await setWriteTarget(second.id);

  const b = await beginUpload(owner as any, spaceId, null, "new.txt", "text/plain");
  await upload(b.url, "new");
  await completeUpload(owner as any, b.item_id);

  const [oldRow] = await sql`SELECT storage_backend_id FROM items WHERE id = ${a.item_id}`;
  const [newRow] = await sql`SELECT storage_backend_id FROM items WHERE id = ${b.item_id}`;
  expect(oldRow.storage_backend_id).toBe(first);
  expect(newRow.storage_backend_id).toBe(second.id);
});

test("the storage key never contains the user-supplied name", async () => {
  const { owner, spaceId } = await setup();
  const { item_id } = await beginUpload(owner as any, spaceId, null, "../../etc/passwd.txt", "text/plain")
    .catch(() => ({ item_id: null }));
  // the name is rejected outright by checkName
  expect(item_id).toBeNull();

  const ok = await beginUpload(owner as any, spaceId, null, "safe name.txt", "text/plain");
  const [row] = await sql`SELECT storage_key FROM items WHERE id = ${ok.item_id}`;
  expect(row.storage_key).toBe(`${spaceId}/${ok.item_id}`);
});

test("uploading into a folder requires EDITOR on that folder", async () => {
  const { owner, spaceId } = await setup();
  const f = await createFolder(owner as any, spaceId, null, "docs");
  const { item_id } = await beginUpload(owner as any, spaceId, f.id, "in-folder.txt", "text/plain");
  const [row] = await sql`SELECT parent_id FROM items WHERE id = ${item_id}`;
  expect(row.parent_id).toBe(f.id);
});

test("beginUpload fails cleanly when no write target exists", async () => {
  const owner = await makeUser();
  const space = await createSpace(owner as any, "S");
  await expect(
    beginUpload(owner as any, space.id, null, "x.txt", "text/plain"),
  ).rejects.toMatchObject({ status: 503 });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && bun test test/upload.test.ts`
Expected: FAIL — cannot resolve `../src/upload.ts`.

- [ ] **Step 3: Write `apps/api/src/upload.ts`**

```ts
import { parseUuids, sql, uuids } from "./db.ts";
import { HttpError } from "./http.ts";
import type { User } from "./auth.ts";
import { EDITOR, type Item, requireItem, requireSpace } from "./perm.ts";
import { checkName } from "./items.ts";
import { backendFor, writeTarget } from "./backends.ts";

const PRESIGN_SECONDS = 900;

const normalizeMime = (m?: string) =>
  (m || "application/octet-stream").split(";")[0].trim().toLowerCase() || "application/octet-stream";

/**
 * Step 1 of the handshake: reserve the row, choose the backend, hand back a
 * presigned PUT. The row is 'pending' until the object is confirmed to exist,
 * so a browser that never finishes leaves nothing visible behind.
 */
export async function beginUpload(
  user: User, spaceId: string, parentId: string | null, name: string, mime?: string,
) {
  const n = checkName(name);

  let parentPath: string[] = [];
  if (parentId) {
    const parent = await requireItem(user.id, parentId, EDITOR);
    if (parent.kind !== "folder") throw new HttpError(400, "parent is not a folder");
    if (parent.space_id !== spaceId) throw new HttpError(400, "parent is in a different space");
    parentPath = parent.path_ids;
  } else {
    await requireSpace(user.id, spaceId, EDITOR);
  }

  const { id: backendId, backend } = await writeTarget();
  const id = crypto.randomUUID();
  // Server-generated. The user's name never reaches the object key.
  const key = `${spaceId}/${id}`;
  const type = normalizeMime(mime);

  try {
    await sql`
      INSERT INTO items (id, space_id, parent_id, kind, name, path_ids, mime,
                         storage_backend_id, storage_key, status, created_by)
      VALUES (${id}, ${spaceId}, ${parentId}, 'file', ${n},
              ${uuids([...parentPath, id])}::uuid[], ${type},
              ${backendId}, ${key}, 'pending', ${user.id})`;
  } catch (e: any) {
    if (e?.errno === "23505") throw new HttpError(409, "an item with that name already exists here");
    throw e;
  }

  return { item_id: id, url: backend.presignPut(key, type, PRESIGN_SECONDS), expires_in: PRESIGN_SECONDS };
}

/**
 * Step 2: confirm the object landed, then publish the row.
 *
 * Size and mime are read from the storage backend, never accepted from the
 * caller. A client-supplied size would be a quota bypass and a metadata
 * forgery primitive, and this endpoint is reachable by anyone who can upload.
 */
export async function completeUpload(user: User, itemId: string): Promise<Item> {
  const item = await requireItem(user.id, itemId, EDITOR);
  if (item.kind !== "file") throw new HttpError(400, "not a file");
  if (item.status === "ready") return item;

  const backend = await backendFor(item.storage_backend_id!);
  const head = await backend.head(item.storage_key!);
  if (!head) throw new HttpError(400, "no object was uploaded for this item");

  const [row] = await sql`
    UPDATE items SET size = ${head.size}, mime = ${head.mime}, status = 'ready'
     WHERE id = ${itemId} RETURNING *`;
  return { ...row, path_ids: parseUuids(row.path_ids), size: Number(row.size) } as Item;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && bun test test/upload.test.ts`
Expected: 9 pass.

- [ ] **Step 5: Add routes to `apps/api/src/server.ts`**

```ts
import { beginUpload, completeUpload } from "./upload.ts";
```

```ts
  "/api/spaces/:id/uploads": {
    POST: route(async (req) => {
      const u = await requireUser(req);
      const b = await body<{ name: string; parent_id?: string | null; mime?: string }>(req);
      return json(await beginUpload(u, req.params.id, b.parent_id ?? null, b.name, b.mime), 201);
    }),
  },

  "/api/items/:id/complete": {
    POST: route(async (req) => json(await completeUpload(await requireUser(req), req.params.id))),
  },
```

- [ ] **Step 6: Run all tests, then commit**

```bash
cd apps/api && bun test
git add apps/api
git commit -m "feat: presigned upload handshake with storage-verified metadata"
```

---

### Task 7: Download and range streaming

**Files:**
- Create: `apps/api/src/content.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/test/content.test.ts`

**Interfaces:**
- Produces: `streamItem(item, range?, disposition?): Promise<Response>`, `serveContent(user, itemId, range?, disposition?): Promise<Response>`

- [ ] **Step 1: Write the failing test** — `apps/api/test/content.test.ts`

```ts
import { beforeEach, expect, test } from "bun:test";
import { invalidateBackendCache, createBackend } from "../src/backends.ts";
import { serveContent } from "../src/content.ts";
import { beginUpload, completeUpload } from "../src/upload.ts";
import { addSpaceMember, createSpace } from "../src/spaces.ts";
import { VIEWER } from "../src/perm.ts";
import { makeUser, resetDb, withServer } from "./helpers.ts";
import { devConfig } from "./storage.test.ts";

beforeEach(async () => { await resetDb(); invalidateBackendCache(); });

const CONTENT = "0123456789abcdefghij"; // 20 bytes

async function uploaded(name = "clip.mp4", mime = "video/mp4") {
  const owner = await makeUser();
  const space = await createSpace(owner as any, "S");
  await createBackend({ name: "primary", config: devConfig, makeWriteTarget: true });
  const { item_id, url } = await beginUpload(owner as any, space.id, null, name, mime);
  await fetch(url, { method: "PUT", body: CONTENT, headers: { "content-type": mime } });
  await completeUpload(owner as any, item_id);
  return { owner, spaceId: space.id, itemId: item_id };
}

test("a full download returns the whole object", async () => {
  const { owner, itemId } = await uploaded();
  const r = await serveContent(owner as any, itemId);
  expect(r.status).toBe(200);
  expect(await r.text()).toBe(CONTENT);
  expect(r.headers.get("accept-ranges")).toBe("bytes");
});

test("a range request returns 206 with the right slice — video seeking", async () => {
  const { owner, itemId } = await uploaded();
  const r = await serveContent(owner as any, itemId, "bytes=5-9");
  expect(r.status).toBe(206);
  expect(r.headers.get("content-range")).toBe("bytes 5-9/20");
  expect(r.headers.get("content-length")).toBe("5");
  expect(await r.text()).toBe("56789");
});

test("content-disposition carries the item name, not the storage key", async () => {
  const { owner, itemId } = await uploaded("Quarterly Report.pdf", "application/pdf");
  const r = await serveContent(owner as any, itemId, null, "attachment");
  expect(r.headers.get("content-disposition")).toContain("Quarterly%20Report.pdf");
  expect(r.headers.get("content-disposition")).toStartWith("attachment");
});

test("inline disposition is used for viewing", async () => {
  const { owner, itemId } = await uploaded();
  const r = await serveContent(owner as any, itemId, null, "inline");
  expect(r.headers.get("content-disposition")).toStartWith("inline");
});

test("a user without access gets 404, not the bytes", async () => {
  const { itemId } = await uploaded();
  const stranger = await makeUser();
  await expect(serveContent(stranger as any, itemId)).rejects.toMatchObject({ status: 404 });
});

test("a VIEWER can download", async () => {
  const { owner, spaceId, itemId } = await uploaded();
  const viewer = await makeUser();
  await addSpaceMember(owner as any, spaceId, { type: "user", id: viewer.id }, VIEWER);
  expect((await serveContent(viewer as any, itemId)).status).toBe(200);
});

test("a pending upload cannot be downloaded", async () => {
  const owner = await makeUser();
  const space = await createSpace(owner as any, "S");
  await createBackend({ name: "primary", config: devConfig, makeWriteTarget: true });
  const { item_id } = await beginUpload(owner as any, space.id, null, "half.txt", "text/plain");
  await expect(serveContent(owner as any, item_id)).rejects.toMatchObject({ status: 409 });
});

test("range streaming works end to end over HTTP", async () => {
  const { owner, itemId } = await uploaded();
  await withServer(async (base) => {
    const r = await fetch(`${base}/api/items/${itemId}/content`, {
      headers: { authorization: `Bearer ${owner.token}`, range: "bytes=10-14" },
    });
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe("bytes 10-14/20");
    expect(await r.text()).toBe("abcde");
  });
});

test("an unauthenticated content request is rejected", async () => {
  const { itemId } = await uploaded();
  await withServer(async (base) => {
    const r = await fetch(`${base}/api/items/${itemId}/content`);
    expect(r.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && bun test test/content.test.ts`
Expected: FAIL — cannot resolve `../src/content.ts`.

- [ ] **Step 3: Write `apps/api/src/content.ts`**

```ts
import { HttpError } from "./http.ts";
import type { User } from "./auth.ts";
import { VIEWER, type Item, requireItem } from "./perm.ts";
import { backendFor } from "./backends.ts";

export type Disposition = "inline" | "attachment";

/**
 * Streams an item's bytes, forwarding any Range through to storage.
 *
 * Downloads are proxied rather than presigned so the permission check cannot be
 * bypassed: a presigned GET URL, once issued, works for anyone holding it for
 * as long as it lives. Video seeking is a byproduct of Range support here, so
 * there is no separate video path that could skip this check.
 */
export async function streamItem(
  item: Item, range?: string | null, disposition: Disposition = "attachment",
): Promise<Response> {
  if (item.kind !== "file") throw new HttpError(400, "not a file");
  if (item.status !== "ready") throw new HttpError(409, "this upload has not been completed");

  const backend = await backendFor(item.storage_backend_id!);
  const res = await backend.getStream(item.storage_key!, range);

  const headers = new Headers(res.headers);
  headers.set(
    "content-disposition",
    `${disposition}; filename*=UTF-8''${encodeURIComponent(item.name)}`,
  );
  headers.set("cache-control", "private, max-age=0, must-revalidate");
  // Storage reports the object's own type; the item's recorded mime is the same
  // value (both came from head() at completion), so nothing to reconcile.
  return new Response(res.body, { status: res.status, headers });
}

export async function serveContent(
  user: User, itemId: string, range?: string | null, disposition: Disposition = "attachment",
): Promise<Response> {
  const item = await requireItem(user.id, itemId, VIEWER);
  return streamItem(item, range, disposition);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && bun test test/content.test.ts`
Expected: 9 pass.

- [ ] **Step 5: Add the route to `apps/api/src/server.ts`**

```ts
import { serveContent } from "./content.ts";
```

```ts
  "/api/items/:id/content": {
    GET: route(async (req) => {
      const u = await requireUser(req);
      const inline = new URL(req.url).searchParams.get("inline") === "1";
      return serveContent(u, req.params.id, req.headers.get("range"), inline ? "inline" : "attachment");
    }),
  },
```

- [ ] **Step 6: Run all tests, then commit**

```bash
cd apps/api && bun test
git add apps/api
git commit -m "feat: proxied downloads with range streaming for video"
```

---

### Task 8: Share links

**Files:**
- Create: `apps/api/src/share.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/test/share.test.ts`

**Interfaces:**
- Produces: `createShare(user, itemId, opts): Promise<{ id, token, mode, expires_at }>`, `listShares(user, itemId)`, `revokeShare(user, linkId)`, `resolveShare(token, password?): Promise<{ link, item }>`

- [ ] **Step 1: Write the failing test** — `apps/api/test/share.test.ts`

```ts
import { beforeEach, expect, test } from "bun:test";
import { sql } from "../src/db.ts";
import { createBackend, invalidateBackendCache } from "../src/backends.ts";
import { createShare, listShares, resolveShare, revokeShare } from "../src/share.ts";
import { beginUpload, completeUpload } from "../src/upload.ts";
import { addSpaceMember, createSpace } from "../src/spaces.ts";
import { VIEWER } from "../src/perm.ts";
import { makeUser, resetDb, withServer } from "./helpers.ts";
import { devConfig } from "./storage.test.ts";

beforeEach(async () => { await resetDb(); invalidateBackendCache(); });

const CONTENT = "0123456789abcdefghij";

async function uploaded() {
  const owner = await makeUser();
  const space = await createSpace(owner as any, "S");
  await createBackend({ name: "primary", config: devConfig, makeWriteTarget: true });
  const { item_id, url } = await beginUpload(owner as any, space.id, null, "clip.mp4", "video/mp4");
  await fetch(url, { method: "PUT", body: CONTENT, headers: { "content-type": "video/mp4" } });
  await completeUpload(owner as any, item_id);
  return { owner, spaceId: space.id, itemId: item_id };
}

test("the raw token is returned once and only its hash is stored", async () => {
  const { owner, itemId } = await uploaded();
  const link = await createShare(owner as any, itemId, {});
  expect(link.token.length).toBeGreaterThan(20);
  const [row] = await sql`SELECT token_hash FROM share_links WHERE id = ${link.id}`;
  expect(row.token_hash).not.toContain(link.token);
  // listing never re-exposes it
  expect(JSON.stringify(await listShares(owner as any, itemId))).not.toContain(link.token);
});

test("expiry defaults to 7 days", async () => {
  const { owner, itemId } = await uploaded();
  const link = await createShare(owner as any, itemId, {});
  const days = (new Date(link.expires_at!).getTime() - Date.now()) / 86400_000;
  expect(days).toBeGreaterThan(6.9);
  expect(days).toBeLessThan(7.1);
});

test("an explicit never-expires link is allowed", async () => {
  const { owner, itemId } = await uploaded();
  const link = await createShare(owner as any, itemId, { expiresInDays: null });
  expect(link.expires_at).toBeNull();
  expect((await resolveShare(link.token)).item.id).toBe(itemId);
});

test("a valid token resolves to the item", async () => {
  const { owner, itemId } = await uploaded();
  const link = await createShare(owner as any, itemId, {});
  const { item, link: l } = await resolveShare(link.token);
  expect(item.id).toBe(itemId);
  expect(l.mode).toBe("view");
});

test("an expired link is rejected", async () => {
  const { owner, itemId } = await uploaded();
  const link = await createShare(owner as any, itemId, {});
  await sql`UPDATE share_links SET expires_at = now() - interval '1 minute' WHERE id = ${link.id}`;
  await expect(resolveShare(link.token)).rejects.toMatchObject({ status: 404 });
});

test("a revoked link is rejected", async () => {
  const { owner, itemId } = await uploaded();
  const link = await createShare(owner as any, itemId, {});
  await revokeShare(owner as any, link.id);
  await expect(resolveShare(link.token)).rejects.toMatchObject({ status: 404 });
});

test("an unknown token is rejected", async () => {
  await expect(resolveShare("not-a-real-token")).rejects.toMatchObject({ status: 404 });
});

test("a password-protected link needs the right password", async () => {
  const { owner, itemId } = await uploaded();
  const link = await createShare(owner as any, itemId, { password: "letmein123" });
  await expect(resolveShare(link.token)).rejects.toMatchObject({ status: 401 });
  await expect(resolveShare(link.token, "wrong-one")).rejects.toMatchObject({ status: 401 });
  expect((await resolveShare(link.token, "letmein123")).item.id).toBe(itemId);
});

test("a link to a trashed item stops working", async () => {
  const { owner, itemId } = await uploaded();
  const link = await createShare(owner as any, itemId, {});
  await sql`UPDATE items SET deleted_at = now() WHERE id = ${itemId}`;
  await expect(resolveShare(link.token)).rejects.toMatchObject({ status: 404 });
});

test("any EDITOR can create a link; a VIEWER cannot", async () => {
  const { owner, spaceId, itemId } = await uploaded();
  const viewer = await makeUser();
  await addSpaceMember(owner as any, spaceId, { type: "user", id: viewer.id }, VIEWER);
  await expect(createShare(viewer as any, itemId, {})).rejects.toMatchObject({ status: 403 });
});

test("the public route streams, honours Range, and respects view mode", async () => {
  const { owner, itemId } = await uploaded();
  const view = await createShare(owner as any, itemId, { mode: "view" });
  const dl = await createShare(owner as any, itemId, { mode: "download" });

  await withServer(async (base) => {
    const r = await fetch(`${base}/s/${view.token}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toStartWith("inline");
    expect(await r.text()).toBe(CONTENT);

    // seeking a shared video with no login
    const seek = await fetch(`${base}/s/${view.token}`, { headers: { range: "bytes=3-7" } });
    expect(seek.status).toBe(206);
    expect(await seek.text()).toBe("34567");

    const d = await fetch(`${base}/s/${dl.token}`);
    expect(d.headers.get("content-disposition")).toStartWith("attachment");

    const bad = await fetch(`${base}/s/nope`);
    expect(bad.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && bun test test/share.test.ts`
Expected: FAIL — cannot resolve `../src/share.ts`.

- [ ] **Step 3: Write `apps/api/src/share.ts`**

```ts
import { sql } from "./db.ts";
import { HttpError, sha256 } from "./http.ts";
import type { User } from "./auth.ts";
import { EDITOR, type Item, loadItem, requireItem } from "./perm.ts";

const DEFAULT_DAYS = 7;

export type ShareMode = "view" | "download";
export type ShareOpts = {
  mode?: ShareMode;
  password?: string;
  /** undefined = 7 days; null = never expires; a number = that many days. */
  expiresInDays?: number | null;
};

const newToken = () =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

/**
 * Only the SHA-256 of the token is stored, so a database dump is not a set of
 * live URLs. The raw token is returned exactly once, here.
 */
export async function createShare(user: User, itemId: string, opts: ShareOpts) {
  const item = await requireItem(user.id, itemId, EDITOR);
  if (item.kind !== "file") throw new HttpError(400, "only files can be shared");

  const mode: ShareMode = opts.mode ?? "view";
  if (mode !== "view" && mode !== "download") throw new HttpError(400, "mode must be view or download");

  const days = opts.expiresInDays === null ? null : (opts.expiresInDays ?? DEFAULT_DAYS);
  if (days !== null && (!Number.isFinite(days) || days <= 0))
    throw new HttpError(400, "expiresInDays must be a positive number or null");
  const expiresAt = days === null ? null : new Date(Date.now() + days * 86400_000);

  const token = newToken();
  const [row] = await sql`
    INSERT INTO share_links (token_hash, item_id, mode, password_hash, expires_at, created_by)
    VALUES (${sha256(token)}, ${itemId}, ${mode},
            ${opts.password ? await Bun.password.hash(opts.password) : null},
            ${expiresAt}, ${user.id})
    RETURNING id, mode, expires_at, created_at`;

  return { ...row, token };
}

export async function listShares(user: User, itemId: string) {
  await requireItem(user.id, itemId, EDITOR);
  return await sql`
    SELECT id, mode, expires_at, revoked_at, created_at,
           (password_hash IS NOT NULL) AS has_password
      FROM share_links WHERE item_id = ${itemId} ORDER BY created_at DESC`;
}

export async function revokeShare(user: User, linkId: string) {
  const [link] = await sql`SELECT item_id FROM share_links WHERE id = ${linkId}`;
  if (!link) throw new HttpError(404, "link not found");
  await requireItem(user.id, link.item_id, EDITOR);
  await sql`UPDATE share_links SET revoked_at = now() WHERE id = ${linkId} AND revoked_at IS NULL`;
}

/**
 * Resolves a public token. No user is involved: the link IS the grant, which is
 * why expiry and revocation are the only brakes and both are checked here.
 * Every rejection is the same 404 so a probe cannot tell "expired" from
 * "never existed".
 */
export async function resolveShare(
  token: string, password?: string,
): Promise<{ link: any; item: Item }> {
  const [link] = await sql`SELECT * FROM share_links WHERE token_hash = ${sha256(token ?? "")}`;
  if (!link || link.revoked_at) throw new HttpError(404, "link not found or expired");
  if (link.expires_at && new Date(link.expires_at) <= new Date())
    throw new HttpError(404, "link not found or expired");

  if (link.password_hash) {
    if (!password || !(await Bun.password.verify(password, link.password_hash)))
      throw new HttpError(401, "password required");
  }

  const item = await loadItem(link.item_id); // throws 404 if trashed
  return { link, item };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && bun test test/share.test.ts`
Expected: 11 pass.

- [ ] **Step 5: Add routes to `apps/api/src/server.ts`**

The public `/s/:token` route takes no session. `mode` decides the disposition — and note in the API docs that view-only is a speed bump, not DRM.

```ts
import { createShare, listShares, resolveShare, revokeShare } from "./share.ts";
import { streamItem } from "./content.ts";
```

```ts
  "/api/items/:id/shares": {
    GET: route(async (req) => json(await listShares(await requireUser(req), req.params.id))),
    POST: route(async (req) => {
      const u = await requireUser(req);
      const b = await body<{ mode?: "view" | "download"; password?: string; expiresInDays?: number | null }>(req);
      return json(await createShare(u, req.params.id, b), 201);
    }),
  },

  "/api/shares/:id": {
    DELETE: route(async (req) => {
      await revokeShare(await requireUser(req), req.params.id);
      return new Response(null, { status: 204 });
    }),
  },

  // Public. The token is the only credential.
  "/s/:token": {
    GET: route(async (req) => {
      const password = new URL(req.url).searchParams.get("password") ?? undefined;
      const { link, item } = await resolveShare(req.params.token, password);
      return streamItem(item, req.headers.get("range"), link.mode === "view" ? "inline" : "attachment");
    }),
  },
```

- [ ] **Step 6: Run all tests, then commit**

```bash
cd apps/api && bun test
git add apps/api
git commit -m "feat: expiring, revocable share links with optional passwords"
```

---

### Task 9: Trash, purge, and the pending sweeper

**Files:**
- Create: `apps/api/src/trash.ts`
- Create: `apps/api/scripts/jobs.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/test/trash.test.ts`

**Interfaces:**
- Produces: `deleteItem(user, itemId)`, `restoreItem(user, itemId)`, `listTrash(user, spaceId)`, `purgeExpired(retentionDays?): Promise<number>`, `sweepPending(hours?): Promise<number>`

- [ ] **Step 1: Write the failing test** — `apps/api/test/trash.test.ts`

```ts
import { beforeEach, expect, test } from "bun:test";
import { sql } from "../src/db.ts";
import { backendFor, createBackend, invalidateBackendCache, setWriteTarget } from "../src/backends.ts";
import { deleteItem, listTrash, purgeExpired, restoreItem, sweepPending } from "../src/trash.ts";
import { beginUpload, completeUpload } from "../src/upload.ts";
import { createFolder, listChildren } from "../src/items.ts";
import { createSpace } from "../src/spaces.ts";
import { requireItem, VIEWER } from "../src/perm.ts";
import { makeUser, resetDb } from "./helpers.ts";
import { devConfig } from "./storage.test.ts";

beforeEach(async () => { await resetDb(); invalidateBackendCache(); });

async function setup() {
  const owner = await makeUser();
  const space = await createSpace(owner as any, "S");
  const backend = await createBackend({ name: "primary", config: devConfig, makeWriteTarget: true });
  return { owner, spaceId: space.id, backendId: backend.id };
}

async function uploadFile(owner: any, spaceId: string, parentId: string | null, name: string) {
  const { item_id, url } = await beginUpload(owner, spaceId, parentId, name, "text/plain");
  await fetch(url, { method: "PUT", body: "payload", headers: { "content-type": "text/plain" } });
  await completeUpload(owner, item_id);
  return item_id;
}

test("deleting a folder trashes the whole subtree", async () => {
  const { owner, spaceId } = await setup();
  const a = await createFolder(owner as any, spaceId, null, "a");
  const b = await createFolder(owner as any, spaceId, a.id, "b");
  const f = await uploadFile(owner, spaceId, b.id, "deep.txt");
  const keep = await createFolder(owner as any, spaceId, null, "keep");

  await deleteItem(owner as any, a.id);

  for (const id of [a.id, b.id, f]) {
    const [row] = await sql`SELECT deleted_at FROM items WHERE id = ${id}`;
    expect(row.deleted_at).not.toBeNull();
  }
  const [kept] = await sql`SELECT deleted_at FROM items WHERE id = ${keep.id}`;
  expect(kept.deleted_at).toBeNull();
});

test("trashed items disappear from listings", async () => {
  const { owner, spaceId } = await setup();
  const a = await createFolder(owner as any, spaceId, null, "a");
  await createFolder(owner as any, spaceId, null, "b");
  await deleteItem(owner as any, a.id);
  expect((await listChildren(owner as any, spaceId, null)).map((i: any) => i.name)).toEqual(["b"]);
});

test("restore brings the subtree back", async () => {
  const { owner, spaceId } = await setup();
  const a = await createFolder(owner as any, spaceId, null, "a");
  const b = await createFolder(owner as any, spaceId, a.id, "b");
  await deleteItem(owner as any, a.id);
  await restoreItem(owner as any, a.id);
  expect((await requireItem(owner.id, b.id, VIEWER)).id).toBe(b.id);
});

test("a child cannot be restored while its parent is still trashed", async () => {
  const { owner, spaceId } = await setup();
  const a = await createFolder(owner as any, spaceId, null, "a");
  const b = await createFolder(owner as any, spaceId, a.id, "b");
  await deleteItem(owner as any, a.id);
  await expect(restoreItem(owner as any, b.id)).rejects.toMatchObject({ status: 409 });
});

test("the name is free again once an item is trashed", async () => {
  const { owner, spaceId } = await setup();
  const a = await createFolder(owner as any, spaceId, null, "reports");
  await deleteItem(owner as any, a.id);
  await createFolder(owner as any, spaceId, null, "reports"); // must not conflict
});

test("purge removes rows and their objects after the retention window", async () => {
  const { owner, spaceId, backendId } = await setup();
  const id = await uploadFile(owner, spaceId, null, "old.txt");
  const [{ storage_key }] = await sql`SELECT storage_key FROM items WHERE id = ${id}`;

  await deleteItem(owner as any, id);
  await sql`UPDATE items SET deleted_at = now() - interval '31 days' WHERE id = ${id}`;

  expect(await purgeExpired(30)).toBe(1);
  expect(await sql`SELECT 1 FROM items WHERE id = ${id}`).toHaveLength(0);
  expect(await (await backendFor(backendId)).head(storage_key)).toBeNull();
});

test("purge leaves items still inside the retention window alone", async () => {
  const { owner, spaceId } = await setup();
  const id = await uploadFile(owner, spaceId, null, "recent.txt");
  await deleteItem(owner as any, id);
  expect(await purgeExpired(30)).toBe(0);
  expect(await sql`SELECT 1 FROM items WHERE id = ${id}`).toHaveLength(1);
});

test("purge deletes each file through its OWN backend", async () => {
  const { owner, spaceId, backendId: first } = await setup();
  const oldId = await uploadFile(owner, spaceId, null, "on-first.txt");
  const [{ storage_key: oldKey }] = await sql`SELECT storage_key FROM items WHERE id = ${oldId}`;

  const second = await createBackend({ name: "secondary", config: devConfig });
  await setWriteTarget(second.id);
  const newId = await uploadFile(owner, spaceId, null, "on-second.txt");

  await deleteItem(owner as any, oldId);
  await sql`UPDATE items SET deleted_at = now() - interval '31 days' WHERE id = ${oldId}`;
  await purgeExpired(30);

  // the file that lived on the retired backend is gone from THAT backend
  expect(await (await backendFor(first)).head(oldKey)).toBeNull();
  // and the newer file is untouched
  expect(await sql`SELECT 1 FROM items WHERE id = ${newId}`).toHaveLength(1);
});

test("the sweeper clears abandoned pending uploads", async () => {
  const { owner, spaceId } = await setup();
  const { item_id } = await beginUpload(owner as any, spaceId, null, "abandoned.txt", "text/plain");
  expect(await sweepPending(24)).toBe(0); // too recent
  await sql`UPDATE items SET created_at = now() - interval '25 hours' WHERE id = ${item_id}`;
  expect(await sweepPending(24)).toBe(1);
  expect(await sql`SELECT 1 FROM items WHERE id = ${item_id}`).toHaveLength(0);
});

test("the sweeper never touches completed uploads", async () => {
  const { owner, spaceId } = await setup();
  const id = await uploadFile(owner, spaceId, null, "done.txt");
  await sql`UPDATE items SET created_at = now() - interval '99 days' WHERE id = ${id}`;
  expect(await sweepPending(24)).toBe(0);
});

test("listTrash shows only trashed items in the space", async () => {
  const { owner, spaceId } = await setup();
  const a = await createFolder(owner as any, spaceId, null, "a");
  await createFolder(owner as any, spaceId, null, "b");
  await deleteItem(owner as any, a.id);
  const trash = await listTrash(owner as any, spaceId);
  expect(trash.map((t: any) => t.name)).toEqual(["a"]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && bun test test/trash.test.ts`
Expected: FAIL — cannot resolve `../src/trash.ts`.

- [ ] **Step 3: Write `apps/api/src/trash.ts`**

```ts
import { parseUuids, sql } from "./db.ts";
import { HttpError } from "./http.ts";
import type { User } from "./auth.ts";
import { EDITOR, VIEWER, requireItem, requireSpace } from "./perm.ts";
import { backendFor } from "./backends.ts";

/** Soft delete. One statement covers the item and every descendant, because
 *  path_ids includes self. */
export async function deleteItem(user: User, itemId: string) {
  await requireItem(user.id, itemId, EDITOR);
  await sql`UPDATE items SET deleted_at = now()
             WHERE path_ids @> ARRAY[${itemId}]::uuid[] AND deleted_at IS NULL`;
}

export async function restoreItem(user: User, itemId: string) {
  const item = await requireItem(user.id, itemId, EDITOR, { includeDeleted: true });
  if (item.parent_id) {
    const [p] = await sql`SELECT deleted_at FROM items WHERE id = ${item.parent_id}`;
    if (p?.deleted_at) throw new HttpError(409, "restore the parent folder first");
  }
  await sql`UPDATE items SET deleted_at = NULL WHERE path_ids @> ARRAY[${itemId}]::uuid[]`;
}

export async function listTrash(user: User, spaceId: string) {
  await requireSpace(user.id, spaceId, VIEWER);
  const rows = await sql`
    SELECT * FROM items
     WHERE space_id = ${spaceId} AND deleted_at IS NOT NULL
       AND (parent_id IS NULL OR parent_id NOT IN
             (SELECT id FROM items WHERE deleted_at IS NOT NULL))
     ORDER BY deleted_at DESC`;
  return rows.map((r: any) => ({ ...r, path_ids: parseUuids(r.path_ids) }));
}

/**
 * Deletes trashed items past the retention window, removing each object through
 * the backend THAT item was stored on. This is why storage_backend_id lives on
 * the row: a retired backend still has to be reachable to clean up after itself.
 *
 * delete() is idempotent, so a partial run is safe to repeat.
 */
export async function purgeExpired(retentionDays = 30): Promise<number> {
  const rows = await sql`
    SELECT id, storage_backend_id, storage_key FROM items
     WHERE deleted_at IS NOT NULL
       AND deleted_at < now() - make_interval(days => ${retentionDays})`;

  let purged = 0;
  for (const r of rows) {
    if (r.storage_key && r.storage_backend_id) {
      try {
        await (await backendFor(r.storage_backend_id)).delete(r.storage_key);
      } catch (e) {
        // Leave the row so the next run retries; never drop a row whose bytes
        // we could not remove, or the object is orphaned forever.
        console.error("purge: failed to delete object for item", r.id, e);
        continue;
      }
    }
    await sql`DELETE FROM items WHERE id = ${r.id}`;
    purged++;
  }
  return purged;
}

/** Removes uploads that were reserved but never completed. */
export async function sweepPending(hours = 24): Promise<number> {
  const rows = await sql`
    SELECT id, storage_backend_id, storage_key FROM items
     WHERE status = 'pending'
       AND created_at < now() - make_interval(hours => ${hours})`;

  let swept = 0;
  for (const r of rows) {
    if (r.storage_key && r.storage_backend_id) {
      try { await (await backendFor(r.storage_backend_id)).delete(r.storage_key); }
      catch (e) { console.error("sweep: failed to delete object for item", r.id, e); continue; }
    }
    await sql`DELETE FROM items WHERE id = ${r.id}`;
    swept++;
  }
  return swept;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && bun test test/trash.test.ts`
Expected: 11 pass.

- [ ] **Step 5: Write `apps/api/scripts/jobs.ts`**

```ts
import { sql } from "../src/db.ts";
import { purgeExpired, sweepPending } from "../src/trash.ts";

const retention = Number(process.env.TRASH_RETENTION_DAYS ?? 30);
const pendingHours = Number(process.env.PENDING_UPLOAD_HOURS ?? 24);

console.log(`purged ${await purgeExpired(retention)} trashed item(s)`);
console.log(`swept ${await sweepPending(pendingHours)} abandoned upload(s)`);
await sql.close();
```

Run it from cron or a scheduler: `cd apps/api && bun run jobs`.

- [ ] **Step 6: Add routes to `apps/api/src/server.ts`**

```ts
import { deleteItem, listTrash, restoreItem } from "./trash.ts";
```

Add `DELETE` to the existing `/api/items/:id` entry, and two new routes:

```ts
  // inside "/api/items/:id":
    DELETE: route(async (req) => {
      await deleteItem(await requireUser(req), req.params.id);
      return new Response(null, { status: 204 });
    }),
```

```ts
  "/api/items/:id/restore": {
    POST: route(async (req) => {
      await restoreItem(await requireUser(req), req.params.id);
      return new Response(null, { status: 204 });
    }),
  },

  "/api/spaces/:id/trash": {
    GET: route(async (req) => json(await listTrash(await requireUser(req), req.params.id))),
  },
```

- [ ] **Step 7: Run the whole suite**

Run: `cd apps/api && bun test`
Expected: every test from tasks 1–9 passes.

- [ ] **Step 8: Commit**

```bash
git add apps/api
git commit -m "feat: trash with restore, retention purge, and pending-upload sweeper"
```

---

## Final verification

- [ ] **Fresh-clone check.** From a clean database, confirm the whole thing stands up:

```bash
docker compose down -v && docker compose up -d
sleep 10
cd apps/api && bun run migrate && bun test
bun run seed:admin admin@hdrive.local hunter2hunter2 "Admin"
```

Expected: migrations apply, the full suite passes, admin is created.

- [ ] **Manual smoke of the multi-backend requirement.** This is the requirement that motivated the project, so exercise it by hand once:
  1. `bun run dev`
  2. As admin, `POST /api/admin/backends` with the MinIO config and `makeWriteTarget: true`
  3. `POST /api/admin/backends/:id/probe` — expect four green steps
  4. Create a space, upload a file, download it
  5. Add a **second** backend, `POST /api/admin/backends/:id/write-target`
  6. Upload a second file
  7. Confirm: the first file still downloads and still deletes; the second file's `storage_backend_id` is the new backend

- [ ] **Confirm no dependencies crept in:** `cat apps/api/package.json` shows no `dependencies` block.

---

## Deferred (do not build here)

Named so a future reader knows these were decided, not forgotten:

- **Frontend** (`apps/web`) — its own spec, once the design file is readable.
- **File versioning** — add when someone needs to recover an overwritten file.
- **Quotas** — `size` is recorded and verified, so the data is there when needed.
- **Full-text search** — name/metadata listing only for now.
- **Deny rules on grants** — grant-only is what makes the resolver auditable.
- **Transcoding / HLS** — progressive MP4 with Range is enough for a team drive.
- **Rate limiting on login and `/s/:token`** — worth adding before this faces the public internet; it is a deployment concern, not a schema one.
