import { beforeEach, expect, test } from "bun:test";
import { sql, uuids } from "../src/db.ts";
import { EDITOR, OWNER, VIEWER, effectiveRole, requireItem, requireSpace } from "../src/perm.ts";
import {
  addGroupMember, addSpaceMember, createGroup, createSpace,
  listGroupMembers, listGroups, listSpaceMembers, listSpaces,
} from "../src/spaces.ts";
import { makeUser, resetDb, withServer } from "./helpers.ts";

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
  //
  // This must insert a REAL grant held by a different (non-admin) user so the
  // test actually exercises the subject filter — a vacuous version with zero
  // grant rows would pass even if admins bypassed everything.
  const u = await makeUser();
  const admin = await makeUser({ admin: true });
  const t = await tree(u.id);
  await grantItem(t.file.id, "user", u.id, OWNER);
  expect(admin.is_admin).toBe(true);
  expect(await effectiveRole(admin.id, t.spaceId, t.file.path)).toBeNull();
  await expect(requireItem(admin.id, t.file.id, VIEWER)).rejects.toMatchObject({ status: 404 });
});

test("a group's space role does not reach a non-member", async () => {
  const member = await makeUser();
  const outsider = await makeUser();
  const t = await tree(member.id);
  const [g] = await sql`INSERT INTO groups (name) VALUES ('eng') RETURNING id`;
  await sql`INSERT INTO group_members (group_id, user_id) VALUES (${g.id}, ${member.id})`;
  await grantSpace(t.spaceId, "group", g.id, EDITOR);
  expect(await effectiveRole(outsider.id, t.spaceId, t.file.path)).toBeNull();
});

test("membership in one space does not grant access to another space", async () => {
  const u = await makeUser();
  const tA = await tree(u.id);
  const tB = await tree(u.id);
  await grantSpace(tA.spaceId, "user", u.id, OWNER);
  expect(await effectiveRole(u.id, tB.spaceId, tB.file.path)).toBeNull();
});

test("an item grant held by one user does not reach another user", async () => {
  const a = await makeUser();
  const b = await makeUser();
  const t = await tree(a.id);
  await grantItem(t.file.id, "user", a.id, OWNER);
  expect(await effectiveRole(b.id, t.spaceId, t.file.path)).toBeNull();
});

test("a group item grant reaches members and not non-members", async () => {
  const member = await makeUser();
  const outsider = await makeUser();
  const t = await tree(member.id);
  const [g] = await sql`INSERT INTO groups (name) VALUES ('eng') RETURNING id`;
  await sql`INSERT INTO group_members (group_id, user_id) VALUES (${g.id}, ${member.id})`;
  await grantItem(t.file.id, "group", g.id, EDITOR);
  expect(await effectiveRole(member.id, t.spaceId, t.file.path)).toBe(EDITOR);
  expect(await effectiveRole(outsider.id, t.spaceId, t.file.path)).toBeNull();
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

test("the space creator becomes its owner", async () => {
  const u = await makeUser();
  const s = await createSpace(u as any, "Marketing");
  expect(await requireSpace(u.id, s.id, OWNER)).toBe(OWNER);
  expect((await listSpaces(u.id)).map((x: any) => x.id)).toContain(s.id);
});

test("only an owner can add space members", async () => {
  const owner = await makeUser();
  const other = await makeUser();
  const s = await createSpace(owner as any, "M");
  await expect(
    addSpaceMember(other as any, s.id, { type: "user", id: other.id }, VIEWER),
  ).rejects.toMatchObject({ status: 404 });

  await addSpaceMember(owner as any, s.id, { type: "user", id: other.id }, VIEWER);
  expect(await requireSpace(other.id, s.id, VIEWER)).toBe(VIEWER);
});

test("adding an existing member updates their role", async () => {
  const owner = await makeUser();
  const other = await makeUser();
  const s = await createSpace(owner as any, "M");
  await addSpaceMember(owner as any, s.id, { type: "user", id: other.id }, VIEWER);
  await addSpaceMember(owner as any, s.id, { type: "user", id: other.id }, EDITOR);
  expect(await requireSpace(other.id, s.id, EDITOR)).toBe(EDITOR);
});

test("group mutators reject a non-admin caller even when invoked directly", async () => {
  const nonAdmin = await makeUser();
  const admin = await makeUser({ admin: true });
  const g = await createGroup(admin as any, "eng");
  await expect(createGroup(nonAdmin as any, "sales")).rejects.toMatchObject({ status: 403 });
  await expect(addGroupMember(nonAdmin as any, g.id, nonAdmin.id)).rejects.toMatchObject({ status: 403 });
});

test("a malformed subject id is rejected with 400, not a Postgres error", async () => {
  const owner = await makeUser();
  const s = await createSpace(owner as any, "M");
  await expect(
    addSpaceMember(owner as any, s.id, { type: "user", id: "not-a-uuid" }, VIEWER),
  ).rejects.toMatchObject({ status: 400 });
});

test("an out-of-range role is rejected with 400, not a Postgres error", async () => {
  const owner = await makeUser();
  const other = await makeUser();
  const s = await createSpace(owner as any, "M");
  await expect(
    addSpaceMember(owner as any, s.id, { type: "user", id: other.id }, 99),
  ).rejects.toMatchObject({ status: 400 });
});

test("a non-string name field returns 400 over HTTP, not 500", async () => {
  await withServer(async (base) => {
    const owner = await makeUser();
    const res = await fetch(`${base}/api/spaces`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ name: 123 }),
    });
    expect(res.status).toBe(400);
  });
});

test("listGroups returns groups with member counts, admin only", async () => {
  const admin = await makeUser({ admin: true });
  const plain = await makeUser();
  const g = await createGroup(admin as any, "eng");
  await addGroupMember(admin as any, g.id, plain.id);

  const rows = await listGroups(admin as any);
  const eng = rows.find((r: any) => r.id === g.id);
  expect(eng.name).toBe("eng");
  expect(eng.member_count).toBe(1);

  await expect(listGroups(plain as any)).rejects.toMatchObject({ status: 403 });
});

test("listGroupMembers returns members without password hashes", async () => {
  const admin = await makeUser({ admin: true });
  const member = await makeUser();
  const g = await createGroup(admin as any, "eng");
  await addGroupMember(admin as any, g.id, member.id);

  const rows = await listGroupMembers(admin as any, g.id);
  expect(rows.map((r: any) => r.id)).toEqual([member.id]);
  expect(JSON.stringify(rows)).not.toContain("password_hash");
  expect(JSON.stringify(rows)).not.toContain("$argon2");
});

test("listSpaceMembers resolves user and group subjects, requires space access", async () => {
  const owner = await makeUser();
  const other = await makeUser();
  const space = await createSpace(owner as any, "S");
  await addSpaceMember(owner as any, space.id, { type: "user", id: other.id }, VIEWER);

  const rows = await listSpaceMembers(owner as any, space.id);
  const mine = rows.find((r: any) => r.subject_id === other.id);
  expect(mine.role).toBe(VIEWER);
  expect(mine.email).toBe(other.email);

  const stranger = await makeUser();
  await expect(listSpaceMembers(stranger as any, space.id)).rejects.toMatchObject({ status: 404 });
});

test("listSpaceMembers never leaks password hashes", async () => {
  const owner = await makeUser();
  const space = await createSpace(owner as any, "S");
  const rows = await listSpaceMembers(owner as any, space.id);
  expect(JSON.stringify(rows)).not.toContain("password_hash");
  expect(JSON.stringify(rows)).not.toContain("$argon2");
});

test("the new list endpoints are reachable and admin-gated over HTTP", async () => {
  const admin = await makeUser({ admin: true });
  const plain = await makeUser();
  const g = await createGroup(admin as any, "eng");
  const space = await createSpace(plain as any, "S");

  await withServer(async (base) => {
    const asAdmin = { authorization: `Bearer ${admin.token}` };
    const asPlain = { authorization: `Bearer ${plain.token}` };

    expect((await fetch(`${base}/api/groups`, { headers: asAdmin })).status).toBe(200);
    expect((await fetch(`${base}/api/groups`, { headers: asPlain })).status).toBe(403);
    expect((await fetch(`${base}/api/groups`)).status).toBe(401);

    expect((await fetch(`${base}/api/groups/${g.id}/members`, { headers: asAdmin })).status).toBe(200);

    const m = await fetch(`${base}/api/spaces/${space.id}/members`, { headers: asPlain });
    expect(m.status).toBe(200);
    expect((await m.json()).length).toBe(1); // the creator, as OWNER

    const denied = await fetch(`${base}/api/spaces/${space.id}/members`, { headers: asAdmin });
    expect(denied.status).toBe(404); // admin is not a member; 404 not 403
  });
});
