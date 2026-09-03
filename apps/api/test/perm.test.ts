import { beforeEach, expect, test } from "bun:test";
import { sql, uuids } from "../src/db.ts";
import { EDITOR, OWNER, VIEWER, effectiveRole, requireItem, requireSpace } from "../src/perm.ts";
import { makeUser, resetDb } from "./helpers.ts";

beforeEach(resetDb);

/** Builds: space -> /root (folder) -> /root/child (folder) -> /root/child/file */
async function tree(ownerId: string) {
  const [space] = await sql`INSERT INTO spaces (name) VALUES ('S') RETURNING id`;
  const mk = async (parent: any, name: string, kind = "folder") => {
    const id = crypto.randomUUID();
    const path = parent ? [...parent.path, id] : [id];
    await sql`INSERT INTO items (id, space_id, parent_id, kind, name, path_ids, created_by, status)
              VALUES (${id}, ${space.id}, ${parent?.id ?? null}, ${kind}, ${name},
                      ${uuids(path)}::uuid[], ${ownerId}, 'ready')`;
    return { id, path };
  };
  const root = await mk(null, "root");
  const child = await mk(root, "child");
  const file = await mk(child, "file.txt", "file");
  return { spaceId: space.id, root, child, file };
}

const grantSpace = (spaceId: string, t: string, id: string, role: number) =>
  sql`INSERT INTO space_members (space_id, subject_type, subject_id, role)
      VALUES (${spaceId}, ${t}, ${id}, ${role})`;

const grantItem = (itemId: string, t: string, id: string, role: number) =>
  sql`INSERT INTO item_grants (item_id, subject_type, subject_id, role)
      VALUES (${itemId}, ${t}, ${id}, ${role})`;

test("no membership and no grant means no access", async () => {
  const u = await makeUser();
  const t = await tree(u.id);
  expect(await effectiveRole(u.id, t.spaceId, t.file.path)).toBeNull();
});

test("space role applies to every item in the space", async () => {
  const u = await makeUser();
  const t = await tree(u.id);
  await grantSpace(t.spaceId, "user", u.id, VIEWER);
  expect(await effectiveRole(u.id, t.spaceId, t.file.path)).toBe(VIEWER);
  expect(await effectiveRole(u.id, t.spaceId, t.root.path)).toBe(VIEWER);
});

test("a group's space role reaches its members", async () => {
  const u = await makeUser();
  const t = await tree(u.id);
  const [g] = await sql`INSERT INTO groups (name) VALUES ('eng') RETURNING id`;
  await sql`INSERT INTO group_members (group_id, user_id) VALUES (${g.id}, ${u.id})`;
  await grantSpace(t.spaceId, "group", g.id, EDITOR);
  expect(await effectiveRole(u.id, t.spaceId, t.file.path)).toBe(EDITOR);
});

test("an ancestor grant inherits down to a descendant", async () => {
  const u = await makeUser();
  const t = await tree(u.id);
  await grantItem(t.root.id, "user", u.id, EDITOR);
  expect(await effectiveRole(u.id, t.spaceId, t.file.path)).toBe(EDITOR);
});

test("a grant directly on the item resolves (path_ids includes self)", async () => {
  const u = await makeUser();
  const t = await tree(u.id);
  await grantItem(t.file.id, "user", u.id, VIEWER);
  expect(await effectiveRole(u.id, t.spaceId, t.file.path)).toBe(VIEWER);
});

test("a grant on a sibling subtree does NOT leak", async () => {
  const u = await makeUser();
  const t = await tree(u.id);
  await grantItem(t.child.id, "user", u.id, OWNER);
  // child's grant must not reach root, which is its ancestor, not descendant
  expect(await effectiveRole(u.id, t.spaceId, t.root.path)).toBeNull();
});

test("highest role wins across every source", async () => {
  const u = await makeUser();
  const t = await tree(u.id);
  const [g] = await sql`INSERT INTO groups (name) VALUES ('eng') RETURNING id`;
  await sql`INSERT INTO group_members (group_id, user_id) VALUES (${g.id}, ${u.id})`;
  await grantSpace(t.spaceId, "user", u.id, VIEWER);   // low
  await grantSpace(t.spaceId, "group", g.id, EDITOR);  // higher
  await grantItem(t.root.id, "user", u.id, OWNER);     // highest
  expect(await effectiveRole(u.id, t.spaceId, t.file.path)).toBe(OWNER);
});

test("a lower item grant never reduces a higher space role", async () => {
  const u = await makeUser();
  const t = await tree(u.id);
  await grantSpace(t.spaceId, "user", u.id, OWNER);
  await grantItem(t.file.id, "user", u.id, VIEWER);
  expect(await effectiveRole(u.id, t.spaceId, t.file.path)).toBe(OWNER);
});

test("a user in no groups resolves without erroring", async () => {
  const u = await makeUser();
  const t = await tree(u.id);
  expect(await effectiveRole(u.id, t.spaceId, t.file.path)).toBeNull();
});

test("requireItem returns 404 (not 403) when the user has no access at all", async () => {
  const u = await makeUser();
  const t = await tree(u.id);
  await expect(requireItem(u.id, t.file.id, VIEWER)).rejects.toMatchObject({ status: 404 });
});

test("requireItem returns 403 when the user can see it but lacks the level", async () => {
  const u = await makeUser();
  const t = await tree(u.id);
  await grantSpace(t.spaceId, "user", u.id, VIEWER);
  await expect(requireItem(u.id, t.file.id, EDITOR)).rejects.toMatchObject({ status: 403 });
});

test("an admin gets NO implicit access to file content", async () => {
  // Spec §5: admin power is the admin surface (backends, users, groups), not
  // silent read access to everyone's files. An admin who needs a file grants
  // themselves access, which leaves a row behind.
  const u = await makeUser();
  const admin = await makeUser({ admin: true });
  const t = await tree(u.id);
  expect(admin.is_admin).toBe(true);
  expect(await effectiveRole(admin.id, t.spaceId, t.file.path)).toBeNull();
  await expect(requireItem(admin.id, t.file.id, VIEWER)).rejects.toMatchObject({ status: 404 });
});

test("requireSpace resolves with an empty path", async () => {
  const u = await makeUser();
  const t = await tree(u.id);
  await grantSpace(t.spaceId, "user", u.id, EDITOR);
  expect(await requireSpace(u.id, t.spaceId, EDITOR)).toBe(EDITOR);
  await expect(requireSpace(u.id, t.spaceId, OWNER)).rejects.toMatchObject({ status: 403 });
});

test("a deleted item is not loadable by default", async () => {
  const u = await makeUser();
  const t = await tree(u.id);
  await grantSpace(t.spaceId, "user", u.id, OWNER);
  await sql`UPDATE items SET deleted_at = now() WHERE id = ${t.file.id}`;
  await expect(requireItem(u.id, t.file.id, VIEWER)).rejects.toMatchObject({ status: 404 });
  const it = await requireItem(u.id, t.file.id, VIEWER, { includeDeleted: true });
  expect(it.id).toBe(t.file.id);
});
