import { beforeEach, expect, test } from "bun:test";
import { sql } from "../src/db.ts";
import { backendFor, createBackend, invalidateBackendCache, setWriteTarget, updateBackend } from "../src/backends.ts";
import { deleteItem, listTrash, purgeExpired, restoreItem, sweepPending } from "../src/trash.ts";
import { beginUpload, completeUpload } from "../src/upload.ts";
import { createFolder, listChildren } from "../src/items.ts";
import { createSpace } from "../src/spaces.ts";
import { requireItem, VIEWER } from "../src/perm.ts";
import { devConfig, devConfig2, makeUser, resetDb } from "./helpers.ts";

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

// devConfig2 points at a genuinely different MinIO bucket (DEV_S3_BUCKET2), not
// just a second config on the same bucket. That is what makes this test able
// to fail: if purgeExpired used writeTarget() (the CURRENT target, "second")
// instead of the item's own storage_backend_id ("first"), the delete would go
// to the wrong bucket and oldKey would still exist on "first" afterwards.
test("purge deletes each file through its OWN backend", async () => {
  const { owner, spaceId, backendId: first } = await setup();
  const oldId = await uploadFile(owner, spaceId, null, "on-first.txt");
  const [{ storage_key: oldKey }] = await sql`SELECT storage_key FROM items WHERE id = ${oldId}`;

  const second = await createBackend({ name: "secondary", config: devConfig2 });
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

// Forces the storage delete to reject (bad credentials, rotated in after the
// object was uploaded with good ones) and asserts the row survives. Deleting
// the row here would orphan the object permanently with no record it existed.
test("a failed storage delete leaves the row for the next run", async () => {
  const { owner, spaceId, backendId } = await setup();
  const id = await uploadFile(owner, spaceId, null, "stuck.txt");

  await deleteItem(owner as any, id);
  await sql`UPDATE items SET deleted_at = now() - interval '31 days' WHERE id = ${id}`;

  await updateBackend(backendId, { config: { ...devConfig, secretAccessKey: "wrong-secret-value" } });

  expect(await purgeExpired(30)).toBe(0);
  expect(await sql`SELECT 1 FROM items WHERE id = ${id}`).toHaveLength(1);
});

// items.parent_id is ON DELETE CASCADE and a folder's own "delete" always
// succeeds (storage_key is NULL), so deleting the folder row would cascade
// away the child whose byte-delete just failed -- orphaning its object with
// no record it ever existed. Both rows must survive, and the count must
// exclude both, not just the file.
test("a folder is not purged while a child's storage delete is failing", async () => {
  const { owner, spaceId, backendId } = await setup();
  const folder = await createFolder(owner as any, spaceId, null, "docs");
  const fileId = await uploadFile(owner, spaceId, folder.id, "f.txt");

  await deleteItem(owner as any, folder.id);
  await sql`UPDATE items SET deleted_at = now() - interval '31 days'
             WHERE id IN (${folder.id}, ${fileId})`;

  await updateBackend(backendId, { config: { ...devConfig, secretAccessKey: "wrong-secret-value" } });

  expect(await purgeExpired(30)).toBe(0);
  expect(await sql`SELECT 1 FROM items WHERE id = ${folder.id}`).toHaveLength(1);
  expect(await sql`SELECT 1 FROM items WHERE id = ${fileId}`).toHaveLength(1);
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

// Mirrors the purge failure test: same protection, same importance. Without
// it, swapping sweepPending's try/catch{continue} for a swallowing .catch
// that still deletes the row leaves every test green.
test("a failed storage delete leaves an abandoned upload's row for the next run", async () => {
  const { owner, spaceId, backendId } = await setup();
  const { item_id } = await beginUpload(owner as any, spaceId, null, "stuck-pending.txt", "text/plain");
  await sql`UPDATE items SET created_at = now() - interval '25 hours' WHERE id = ${item_id}`;

  await updateBackend(backendId, { config: { ...devConfig, secretAccessKey: "wrong-secret-value" } });

  expect(await sweepPending(24)).toBe(0);
  expect(await sql`SELECT 1 FROM items WHERE id = ${item_id}`).toHaveLength(1);
});

test("listTrash shows only trashed items in the space", async () => {
  const { owner, spaceId } = await setup();
  const a = await createFolder(owner as any, spaceId, null, "a");
  await createFolder(owner as any, spaceId, null, "b");
  await deleteItem(owner as any, a.id);
  const trash = await listTrash(owner as any, spaceId);
  expect(trash.map((t: any) => t.name)).toEqual(["a"]);
});

test("listTrash refuses a user with no access to the space", async () => {
  const { spaceId } = await setup();
  const stranger = await makeUser();
  await expect(listTrash(stranger as any, spaceId)).rejects.toMatchObject({ status: 404 });
});

test("listTrash excludes another space's trashed items", async () => {
  const { owner, spaceId } = await setup();
  const otherSpace = await createSpace(owner as any, "other");
  const a = await createFolder(owner as any, spaceId, null, "a");
  const otherItem = await createFolder(owner as any, otherSpace.id, null, "elsewhere");
  await deleteItem(owner as any, a.id);
  await deleteItem(owner as any, otherItem.id);

  const trash = await listTrash(owner as any, spaceId);
  expect(trash.map((t: any) => t.name)).toEqual(["a"]);
});

// Restoring frees the name, same as trashing does; a raw 23505 on
// items_sibling_name must not escape as a 500.
test("restoring into a reused name returns 409, not 500", async () => {
  const { owner, spaceId } = await setup();
  const a = await createFolder(owner as any, spaceId, null, "reports");
  await deleteItem(owner as any, a.id);
  await createFolder(owner as any, spaceId, null, "reports"); // takes the freed name
  await expect(restoreItem(owner as any, a.id)).rejects.toMatchObject({ status: 409 });
});

// b was trashed on its own, independent of a. Trashing a later must not make
// restoring a also undo that separate, deliberate action on b.
test("restoring a folder does not resurrect a child trashed separately", async () => {
  const { owner, spaceId } = await setup();
  const a = await createFolder(owner as any, spaceId, null, "a");
  const b = await createFolder(owner as any, spaceId, a.id, "b");
  await deleteItem(owner as any, b.id);
  await deleteItem(owner as any, a.id);

  await restoreItem(owner as any, a.id);

  const [row] = await sql`SELECT deleted_at FROM items WHERE id = ${b.id}`;
  expect(row.deleted_at).not.toBeNull();
});

// A VIEWER genuinely has access to the item (space membership), so a wrong
// implementation that skipped the EDITOR check would return 200/204, not the
// 404 "no access at all" would produce. Only a real >= EDITOR check makes this 403.
test("a VIEWER is refused deleteItem with 403", async () => {
  const { owner, spaceId } = await setup();
  const a = await createFolder(owner as any, spaceId, null, "a");
  const viewer = await makeUser();
  await sql`INSERT INTO space_members (space_id, subject_type, subject_id, role)
            VALUES (${spaceId}, 'user', ${viewer.id}, ${VIEWER})`;
  await expect(deleteItem(viewer as any, a.id)).rejects.toMatchObject({ status: 403 });
});

test("a VIEWER is refused restoreItem with 403", async () => {
  const { owner, spaceId } = await setup();
  const a = await createFolder(owner as any, spaceId, null, "a");
  await deleteItem(owner as any, a.id);
  const viewer = await makeUser();
  await sql`INSERT INTO space_members (space_id, subject_type, subject_id, role)
            VALUES (${spaceId}, 'user', ${viewer.id}, ${VIEWER})`;
  await expect(restoreItem(viewer as any, a.id)).rejects.toMatchObject({ status: 403 });
});
