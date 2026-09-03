import { parseUuids, sql, uuids } from "./db.ts";
import { HttpError } from "./http.ts";

export const VIEWER = 1;
export const EDITOR = 2;
export const OWNER = 3;

export const ROLE_VALUES: Record<string, number> = { viewer: 1, editor: 2, owner: 3 };

export function parseRole(name: string): number {
  const r = ROLE_VALUES[name];
  if (!r) throw new HttpError(400, "role must be viewer, editor, or owner");
  return r;
}

export type Item = {
  id: string;
  space_id: string;
  parent_id: string | null;
  kind: "folder" | "file";
  name: string;
  path_ids: string[];
  size: number | null;
  mime: string | null;
  storage_backend_id: string | null;
  storage_key: string | null;
  status: "pending" | "ready";
  deleted_at: string | null;
  created_by: string;
  created_at: string;
};

export async function groupIdsOf(userId: string): Promise<string[]> {
  const rows = await sql`SELECT group_id FROM group_members WHERE user_id = ${userId}`;
  return rows.map((r: any) => r.group_id);
}

/**
 * Effective role = the highest role granted by ANY source:
 *   - the user's own space membership, or one of their groups'
 *   - a grant on the item itself or any ancestor (path_ids includes self)
 *
 * Grant-only: nothing here can lower a role, so more grants can only ever mean
 * more access. Returns null for "no access at all".
 */
export async function effectiveRole(
  userId: string,
  spaceId: string,
  pathIds: string[],
  groupIds?: string[],
): Promise<number | null> {
  const gs = groupIds ?? (await groupIdsOf(userId));
  const [r] = await sql`
    SELECT MAX(role)::int AS role FROM (
      SELECT role FROM space_members
       WHERE space_id = ${spaceId}
         AND ( (subject_type = 'user'  AND subject_id = ${userId})
            OR (subject_type = 'group' AND subject_id = ANY(${uuids(gs)}::uuid[])) )
      UNION ALL
      SELECT role FROM item_grants
       WHERE item_id = ANY(${uuids(pathIds)}::uuid[])
         AND ( (subject_type = 'user'  AND subject_id = ${userId})
            OR (subject_type = 'group' AND subject_id = ANY(${uuids(gs)}::uuid[])) )
    ) t`;
  return r?.role ?? null;
}

export async function loadItem(
  id: string,
  opts: { includeDeleted?: boolean } = {},
): Promise<Item> {
  const [row] = await sql`SELECT * FROM items WHERE id = ${id}`;
  if (!row) throw new HttpError(404, "not found");
  if (row.deleted_at && !opts.includeDeleted) throw new HttpError(404, "not found");
  return { ...row, path_ids: parseUuids(row.path_ids), size: row.size === null ? null : Number(row.size) } as Item;
}

/**
 * Loads an item and asserts the caller has at least `min`.
 *
 * No access at all -> 404, deliberately: a 403 would confirm the item exists to
 * someone who should not know that. 403 is reserved for "you can see it but
 * cannot do this to it".
 */
export async function requireItem(
  userId: string,
  itemId: string,
  min: number,
  opts: { includeDeleted?: boolean } = {},
): Promise<Item> {
  const item = await loadItem(itemId, opts);
  const role = await effectiveRole(userId, item.space_id, item.path_ids);
  if (role === null) throw new HttpError(404, "not found");
  if (role < min) throw new HttpError(403, "forbidden");
  return item;
}

export async function requireSpace(userId: string, spaceId: string, min: number): Promise<number> {
  const role = await effectiveRole(userId, spaceId, []);
  if (role === null) throw new HttpError(404, "not found");
  if (role < min) throw new HttpError(403, "forbidden");
  return role;
}
