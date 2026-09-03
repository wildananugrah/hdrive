import { beforeEach, expect, test } from "bun:test";
import { parseUuids, sql, uuids } from "../src/db.ts";
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

/**
 * Invariant that must hold for every item after any move: its path_ids ends
 * with its own id, and when it has a parent, path_ids is exactly the
 * parent's path_ids with its own id appended. This is the property a stale
 * `depth` (a TOCTOU on the pre-transaction read) would violate.
 */
async function assertPathInvariant(id: string) {
  const [row] = await sql`SELECT path_ids, parent_id FROM items WHERE id = ${id}`;
  const path = parseUuids(row.path_ids);
  expect(path[path.length - 1]).toBe(id);
  if (row.parent_id) {
    const [prow] = await sql`SELECT path_ids FROM items WHERE id = ${row.parent_id}`;
    expect(path).toEqual([...parseUuids(prow.path_ids), id]);
  } else {
    expect(path).toEqual([id]);
  }
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

  await assertPathInvariant(a.id);
  await assertPathInvariant(b.id);
  await assertPathInvariant(c.id);
  await assertPathInvariant(d.id);
});

test("moving to the root produces a one-element path", async () => {
  const { owner, spaceId } = await setup();
  const a = await createFolder(owner as any, spaceId, null, "a");
  const b = await createFolder(owner as any, spaceId, a.id, "b");
  await moveItem(owner as any, b.id, null);
  const [row] = await sql`SELECT path_ids, parent_id FROM items WHERE id = ${b.id}`;
  expect(parseUuids(row.path_ids)).toEqual([b.id]);
  expect(row.parent_id).toBeNull();
  await assertPathInvariant(b.id);
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

test("moving requires EDITOR on the item being moved, not just on the destination", async () => {
  const { owner, spaceId } = await setup();
  const a = await createFolder(owner as any, spaceId, null, "a");
  const d = await createFolder(owner as any, spaceId, null, "d");
  const user = await makeUser();
  await addSpaceMember(owner as any, spaceId, { type: "user", id: user.id }, VIEWER);
  // EDITOR on the destination only — must not be enough to move an item they can't edit.
  await sql`INSERT INTO item_grants (item_id, subject_type, subject_id, role)
            VALUES (${d.id}, 'user', ${user.id}, ${EDITOR})`;
  await expect(moveItem(user as any, a.id, d.id)).rejects.toMatchObject({ status: 403 });
});

test("moving requires EDITOR on the destination folder, not just on the item", async () => {
  const { owner, spaceId } = await setup();
  const a = await createFolder(owner as any, spaceId, null, "a");
  const d = await createFolder(owner as any, spaceId, null, "d");
  const user = await makeUser();
  await addSpaceMember(owner as any, spaceId, { type: "user", id: user.id }, VIEWER);
  // EDITOR on the item only — must not be enough to move it into a folder they can't edit.
  await sql`INSERT INTO item_grants (item_id, subject_type, subject_id, role)
            VALUES (${a.id}, 'user', ${user.id}, ${EDITOR})`;
  await expect(moveItem(user as any, a.id, d.id)).rejects.toMatchObject({ status: 403 });
});

test("a grant on the old ancestor stops applying after a move", async () => {
  const { owner, spaceId } = await setup();
  const a = await createFolder(owner as any, spaceId, null, "a");
  const b = await createFolder(owner as any, spaceId, a.id, "b");
  const d = await createFolder(owner as any, spaceId, null, "d");

  const guest = await makeUser();
  await sql`INSERT INTO item_grants (item_id, subject_type, subject_id, role)
            VALUES (${a.id}, 'user', ${guest.id}, ${EDITOR})`;

  // before the move, guest can see b via a's grant
  const before = await requireItem(guest.id, b.id, VIEWER);
  expect(before.id).toBe(b.id);

  await moveItem(owner as any, b.id, d.id);

  // after the move, a's grant no longer covers b
  await expect(requireItem(guest.id, b.id, VIEWER)).rejects.toMatchObject({ status: 404 });
});

test("listChildren rejects a parent from a different space", async () => {
  const { owner, spaceId } = await setup();
  const other = await createSpace(owner as any, "Other");
  const a = await createFolder(owner as any, spaceId, null, "a");
  await expect(listChildren(owner as any, other.id, a.id)).rejects.toMatchObject({ status: 400 });
});

test("moving across spaces is rejected", async () => {
  const { owner, spaceId } = await setup();
  const other = await createSpace(owner as any, "Other");
  const a = await createFolder(owner as any, spaceId, null, "a");
  const otherFolder = await createFolder(owner as any, other.id, null, "of");
  await expect(moveItem(owner as any, a.id, otherFolder.id)).rejects.toMatchObject({ status: 400 });
});

test("moving into a non-folder target is rejected", async () => {
  const { owner, spaceId } = await setup();
  const a = await createFolder(owner as any, spaceId, null, "a");
  const fileId = crypto.randomUUID();
  await sql`INSERT INTO items (id, space_id, parent_id, kind, name, path_ids, created_by, status)
            VALUES (${fileId}, ${spaceId}, NULL, 'file', 'f.txt', ${uuids([fileId])}::uuid[], ${owner.id}, 'ready')`;
  await expect(moveItem(owner as any, a.id, fileId)).rejects.toMatchObject({ status: 400 });
});

test("moving into a folder with a name collision is rejected", async () => {
  const { owner, spaceId } = await setup();
  const d = await createFolder(owner as any, spaceId, null, "d");
  await createFolder(owner as any, spaceId, d.id, "b"); // existing sibling named "b" under d
  const b = await createFolder(owner as any, spaceId, null, "b"); // root-level "b"
  await expect(moveItem(owner as any, b.id, d.id)).rejects.toMatchObject({ status: 409 });
});
