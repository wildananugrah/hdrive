import { beforeEach, expect, test } from "bun:test";
import { parseUuids, sql, uuids } from "../src/db.ts";
import { EDITOR, VIEWER, requireItem } from "../src/perm.ts";
import { createFolder, listChildren, listFolders, moveItem, renameItem } from "../src/items.ts";
import { addSpaceMember, createSpace } from "../src/spaces.ts";
import { makeUser, resetDb, withServer } from "./helpers.ts";

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

/** Walks parent_id to the root. Throws on the second visit to any id, so a
 *  cycle cannot spin forever — and cannot pass. */
async function assertReachesRoot(id: string) {
  const seen = new Set<string>();
  let cur: string | null = id;
  while (cur) {
    expect(seen.has(cur)).toBe(false);
    seen.add(cur);
    const [row] = await sql`SELECT parent_id FROM items WHERE id = ${cur}`;
    cur = row.parent_id as string | null;
  }
}

test("concurrent moves that would form a cycle never leave one", async () => {
  const { owner, spaceId } = await setup();
  // Several rounds: the race is a window, not a certainty. Without the
  // space-scoped advisory lock both moves validate against a pre-move tree and
  // commit A->B and B->A, hiding both subtrees permanently.
  for (let round = 0; round < 8; round++) {
    const a = await createFolder(owner as any, spaceId, null, `a${round}`);
    const b = await createFolder(owner as any, spaceId, null, `b${round}`);

    const results = await Promise.allSettled([
      moveItem(owner as any, a.id, b.id),
      moveItem(owner as any, b.id, a.id),
    ]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBeLessThanOrEqual(1);

    for (const id of [a.id, b.id]) {
      await assertReachesRoot(id);
      await assertPathInvariant(id);
    }
  }
});

test("PATCH applies rename and move together: a failing move rolls the rename back", async () => {
  const { owner, spaceId } = await setup();
  const d = await createFolder(owner as any, spaceId, null, "d");
  await createFolder(owner as any, spaceId, d.id, "taken"); // sibling that will collide
  const b = await createFolder(owner as any, spaceId, null, "b");

  await withServer(async (base) => {
    // "taken" is free at the root, so the rename half succeeds on its own; the
    // move half then collides under d. Both must be undone.
    const res = await fetch(`${base}/api/items/${b.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ name: "taken", parent_id: d.id }),
    });
    expect(res.status).toBe(409);
  });

  const [row] = await sql`SELECT name, parent_id FROM items WHERE id = ${b.id}`;
  expect(row.name).toBe("b");
  expect(row.parent_id).toBeNull();
});

test("PATCH applies both halves when they succeed", async () => {
  const { owner, spaceId } = await setup();
  const d = await createFolder(owner as any, spaceId, null, "d");
  const b = await createFolder(owner as any, spaceId, null, "b");

  await withServer(async (base) => {
    const res = await fetch(`${base}/api/items/${b.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ name: "bee", parent_id: d.id }),
    });
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.name).toBe("bee");
    expect(out.parent_id).toBe(d.id);
  });
  await assertPathInvariant(b.id);
});

test("moving into a folder with a name collision is rejected", async () => {
  const { owner, spaceId } = await setup();
  const d = await createFolder(owner as any, spaceId, null, "d");
  await createFolder(owner as any, spaceId, d.id, "b"); // existing sibling named "b" under d
  const b = await createFolder(owner as any, spaceId, null, "b"); // root-level "b"
  await expect(moveItem(owner as any, b.id, d.id)).rejects.toMatchObject({ status: 409 });
});

// --- Addition A: has_grants / has_live_share on listChildren ---------------

async function childRow(owner: any, spaceId: string, id: string): Promise<any> {
  const rows = await listChildren(owner, spaceId, null);
  return (rows as any[]).find((r) => r.id === id)!;
}

test("listChildren: no grants and no links reports both flags false", async () => {
  const { owner, spaceId } = await setup();
  const a = await createFolder(owner as any, spaceId, null, "a");
  const row = await childRow(owner, spaceId, a.id);
  expect(row.has_grants).toBe(false);
  expect(row.has_live_share).toBe(false);
});

test("listChildren: a grant flips has_grants only", async () => {
  const { owner, spaceId } = await setup();
  const a = await createFolder(owner as any, spaceId, null, "a");
  const guest = await makeUser();
  await sql`INSERT INTO item_grants (item_id, subject_type, subject_id, role)
            VALUES (${a.id}, 'user', ${guest.id}, ${VIEWER})`;
  const row = await childRow(owner, spaceId, a.id);
  expect(row.has_grants).toBe(true);
  expect(row.has_live_share).toBe(false);
});

test("listChildren: a grant on an ancestor folder does NOT set has_grants on a child file", async () => {
  const { owner, spaceId } = await setup();
  const folder = await createFolder(owner as any, spaceId, null, "folder");
  const fileId = crypto.randomUUID();
  await sql`INSERT INTO items (id, space_id, parent_id, kind, name, path_ids, created_by, status)
            VALUES (${fileId}, ${spaceId}, ${folder.id}, 'file', 'f.txt',
                    ${uuids([folder.id, fileId])}::uuid[], ${owner.id}, 'ready')`;
  const guest = await makeUser();
  // grant lives on the FOLDER, not the file -- effectiveRole() still lets it
  // inherit down to the file (path_ids includes ancestors), but has_grants
  // must reflect only grants on the item itself, or the VISIBILITY badge
  // would lie about where the grant actually sits.
  await sql`INSERT INTO item_grants (item_id, subject_type, subject_id, role)
            VALUES (${folder.id}, 'user', ${guest.id}, ${VIEWER})`;

  const rootRow = await childRow(owner, spaceId, folder.id);
  expect(rootRow.has_grants).toBe(true);

  const childRows = await listChildren(owner as any, spaceId, folder.id);
  const fileRow = (childRows as any[]).find((r) => r.id === fileId)!;
  expect(fileRow.has_grants).toBe(false);
});

test("listChildren: a live link flips has_live_share only", async () => {
  const { owner, spaceId } = await setup();
  const a = await createFolder(owner as any, spaceId, null, "a");
  await sql`INSERT INTO share_links (token_hash, item_id, mode, created_by)
            VALUES (${crypto.randomUUID()}, ${a.id}, 'view', ${owner.id})`;
  const row = await childRow(owner, spaceId, a.id);
  expect(row.has_grants).toBe(false);
  expect(row.has_live_share).toBe(true);
});

test("listChildren: a revoked link does not count as live", async () => {
  const { owner, spaceId } = await setup();
  const a = await createFolder(owner as any, spaceId, null, "a");
  await sql`INSERT INTO share_links (token_hash, item_id, mode, created_by, revoked_at)
            VALUES (${crypto.randomUUID()}, ${a.id}, 'view', ${owner.id}, now())`;
  const row = await childRow(owner, spaceId, a.id);
  expect(row.has_live_share).toBe(false);
});

test("listChildren: an expired link does not count as live", async () => {
  const { owner, spaceId } = await setup();
  const a = await createFolder(owner as any, spaceId, null, "a");
  await sql`INSERT INTO share_links (token_hash, item_id, mode, created_by, expires_at)
            VALUES (${crypto.randomUUID()}, ${a.id}, 'view', ${owner.id}, now() - interval '1 hour')`;
  const row = await childRow(owner, spaceId, a.id);
  expect(row.has_live_share).toBe(false);
});

test("listChildren: a never-expiring, non-revoked link IS live", async () => {
  const { owner, spaceId } = await setup();
  const a = await createFolder(owner as any, spaceId, null, "a");
  await sql`INSERT INTO share_links (token_hash, item_id, mode, created_by, expires_at)
            VALUES (${crypto.randomUUID()}, ${a.id}, 'view', ${owner.id}, NULL)`;
  const row = await childRow(owner, spaceId, a.id);
  expect(row.has_live_share).toBe(true);
});

// --- Addition B/C: listFolders + path_ids parsing ---------------------------

test("listFolders returns every folder in the space, not files", async () => {
  const { owner, spaceId } = await setup();
  const a = await createFolder(owner as any, spaceId, null, "a");
  const b = await createFolder(owner as any, spaceId, a.id, "b");
  const fileId = crypto.randomUUID();
  await sql`INSERT INTO items (id, space_id, parent_id, kind, name, path_ids, created_by, status)
            VALUES (${fileId}, ${spaceId}, ${a.id}, 'file', 'f.txt', ${uuids([a.id, fileId])}::uuid[], ${owner.id}, 'ready')`;

  const folders = await listFolders(owner as any, spaceId);
  expect(folders.map((f: any) => f.id).sort()).toEqual([a.id, b.id].sort());
});

test("listFolders excludes trashed folders", async () => {
  const { owner, spaceId } = await setup();
  const a = await createFolder(owner as any, spaceId, null, "a");
  const b = await createFolder(owner as any, spaceId, null, "b");
  await sql`UPDATE items SET deleted_at = now() WHERE id = ${b.id}`;

  const folders = await listFolders(owner as any, spaceId);
  expect(folders.map((f: any) => f.id)).toEqual([a.id]);
});

test("listFolders' path_ids round-trips as a real array, not the raw {a,b} string", async () => {
  const { owner, spaceId } = await setup();
  const a = await createFolder(owner as any, spaceId, null, "a");
  const b = await createFolder(owner as any, spaceId, a.id, "b");

  const folders = await listFolders(owner as any, spaceId);
  const row = folders.find((f: any) => f.id === b.id)!;
  expect(Array.isArray(row.path_ids)).toBe(true);
  expect(row.path_ids).toEqual([a.id, b.id]);
});

test("listFolders is gated by VIEWER: a non-member gets 404", async () => {
  const { spaceId } = await setup();
  const stranger = await makeUser();
  await expect(listFolders(stranger as any, spaceId)).rejects.toMatchObject({ status: 404 });
});

test("GET /api/spaces/:id/folders is reachable over HTTP", async () => {
  const { owner, spaceId } = await setup();
  const a = await createFolder(owner as any, spaceId, null, "a");
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/spaces/${spaceId}/folders`, {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(res.status).toBe(200);
    const rows = await res.json();
    expect(rows.map((r: any) => r.id)).toContain(a.id);

    const stranger = await makeUser();
    const denied = await fetch(`${base}/api/spaces/${spaceId}/folders`, {
      headers: { authorization: `Bearer ${stranger.token}` },
    });
    expect(denied.status).toBe(404);
  });
});
