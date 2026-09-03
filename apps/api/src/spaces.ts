import { sql } from "./db.ts";
import { HttpError, isUuid } from "./http.ts";
import type { User } from "./auth.ts";
import { OWNER, VIEWER, requireItem, requireSpace } from "./perm.ts";

export type Subject = { type: "user" | "group"; id: string };

/** Canonical uuid check for any id reaching a trust boundary from a param or
 *  body, so a malformed id is a 400 instead of a Postgres 22P02 (i.e. a 500). */
export function checkUuid(id: unknown, field: string): string {
  if (!isUuid(id)) throw new HttpError(400, `${field} must be a uuid`);
  return id;
}

function checkSubject(s: Subject) {
  if (s?.type !== "user" && s?.type !== "group") throw new HttpError(400, "subject.type must be user or group");
  checkUuid(s?.id, "subject.id");
}

function checkRole(role: number) {
  if (!Number.isInteger(role) || role < VIEWER || role > OWNER) {
    throw new HttpError(400, "role must be viewer, editor, or owner");
  }
}

function requireAdminUser(user: User) {
  if (!user?.is_admin) throw new HttpError(403, "admin only");
}

/** The creator becomes the space's owner; otherwise nobody could administer it. */
export async function createSpace(user: User, name: string) {
  if (!name?.trim()) throw new HttpError(400, "name is required");
  return await sql.begin(async (tx: any) => {
    const [space] = await tx`INSERT INTO spaces (name) VALUES (${name.trim()}) RETURNING *`;
    await tx`INSERT INTO space_members (space_id, subject_type, subject_id, role)
             VALUES (${space.id}, 'user', ${user.id}, ${OWNER})`;
    return space;
  });
}

export async function listSpaces(userId: string) {
  return await sql`
    SELECT DISTINCT s.id, s.name, s.created_at
      FROM spaces s
      JOIN space_members m ON m.space_id = s.id
     WHERE (m.subject_type = 'user'  AND m.subject_id = ${userId})
        OR (m.subject_type = 'group' AND m.subject_id IN
              (SELECT group_id FROM group_members WHERE user_id = ${userId}))
     ORDER BY s.name`;
}

export async function addSpaceMember(user: User, spaceId: string, subject: Subject, role: number) {
  checkSubject(subject);
  checkRole(role);
  await requireSpace(user.id, spaceId, OWNER);
  await sql`
    INSERT INTO space_members (space_id, subject_type, subject_id, role)
    VALUES (${spaceId}, ${subject.type}, ${subject.id}, ${role})
    ON CONFLICT (space_id, subject_type, subject_id) DO UPDATE SET role = EXCLUDED.role`;
}

export async function removeSpaceMember(user: User, spaceId: string, subject: Subject) {
  checkSubject(subject);
  await requireSpace(user.id, spaceId, OWNER);
  await sql`DELETE FROM space_members
             WHERE space_id = ${spaceId} AND subject_type = ${subject.type} AND subject_id = ${subject.id}`;
}

/** Groups are org-wide, so only admins manage them. Self-guarded: does not rely
 *  solely on the route remembering to call requireAdmin. */
export async function createGroup(user: User, name: string) {
  requireAdminUser(user);
  if (!name?.trim()) throw new HttpError(400, "name is required");
  try {
    const [g] = await sql`INSERT INTO groups (name) VALUES (${name.trim()}) RETURNING *`;
    return g;
  } catch (e: any) {
    if (e?.errno === "23505") throw new HttpError(409, "group already exists");
    throw e;
  }
}

export async function addGroupMember(user: User, groupId: string, userId: string) {
  requireAdminUser(user);
  try {
    await sql`INSERT INTO group_members (group_id, user_id) VALUES (${groupId}, ${userId})
              ON CONFLICT DO NOTHING`;
  } catch (e: any) {
    if (e?.errno === "23503") throw new HttpError(404, "group or user not found");
    throw e;
  }
}

export async function removeGroupMember(user: User, groupId: string, userId: string) {
  requireAdminUser(user);
  await sql`DELETE FROM group_members WHERE group_id = ${groupId} AND user_id = ${userId}`;
}

/** Managing grants on an item requires OWNER on that item. */
export async function grantItem(user: User, itemId: string, subject: Subject, role: number) {
  checkSubject(subject);
  checkRole(role);
  await requireItem(user.id, itemId, OWNER);
  await sql`
    INSERT INTO item_grants (item_id, subject_type, subject_id, role)
    VALUES (${itemId}, ${subject.type}, ${subject.id}, ${role})
    ON CONFLICT (item_id, subject_type, subject_id) DO UPDATE SET role = EXCLUDED.role`;
}

export async function revokeItemGrant(user: User, itemId: string, subject: Subject) {
  checkSubject(subject);
  await requireItem(user.id, itemId, OWNER);
  await sql`DELETE FROM item_grants
             WHERE item_id = ${itemId} AND subject_type = ${subject.type} AND subject_id = ${subject.id}`;
}

export async function listItemGrants(user: User, itemId: string) {
  await requireItem(user.id, itemId, OWNER);
  return await sql`SELECT subject_type, subject_id, role FROM item_grants WHERE item_id = ${itemId}`;
}

/** Groups are org-wide, so listing them is admin-only, matching the mutators. */
export async function listGroups(user: User) {
  requireAdminUser(user);
  return await sql`
    SELECT g.id, g.name, g.created_at,
           (SELECT count(*)::int FROM group_members m WHERE m.group_id = g.id) AS member_count
      FROM groups g ORDER BY lower(g.name)`;
}

export async function listGroupMembers(user: User, groupId: string) {
  requireAdminUser(user);
  checkUuid(groupId, "group id");
  return await sql`
    SELECT u.id, u.email, u.name
      FROM group_members m JOIN users u ON u.id = m.user_id
     WHERE m.group_id = ${groupId}
     ORDER BY lower(u.name)`;
}

/**
 * Members of a space, with each subject resolved to a display name.
 * Requires VIEWER on the space: anyone who can see the space can see who is in
 * it, but a non-member gets the same 404 as a non-existent space.
 */
export async function listSpaceMembers(user: User, spaceId: string) {
  checkUuid(spaceId, "space id");
  await requireSpace(user.id, spaceId, VIEWER);
  return await sql`
    SELECT m.subject_type, m.subject_id, m.role,
           COALESCE(u.name, g.name) AS name,
           u.email AS email
      FROM space_members m
      LEFT JOIN users  u ON m.subject_type = 'user'  AND u.id = m.subject_id
      LEFT JOIN groups g ON m.subject_type = 'group' AND g.id = m.subject_id
     WHERE m.space_id = ${spaceId}
     ORDER BY m.subject_type, lower(COALESCE(u.name, g.name))`;
}
