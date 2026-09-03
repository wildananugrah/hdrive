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
