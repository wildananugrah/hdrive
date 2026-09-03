import { parseUuids, sql, uuids } from "./db.ts";
import { HttpError } from "./http.ts";
import type { User } from "./auth.ts";
import { EDITOR, VIEWER, type Item, loadItem, requireItem, requireSpace } from "./perm.ts";

/** Names are user-visible and become Content-Disposition filenames. Keep them boring. */
export function checkName(name: unknown): string {
  if (name !== undefined && name !== null && typeof name !== "string")
    throw new HttpError(400, "name must be a string");
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
  if (parentId) {
    const parent = await requireItem(user.id, parentId, VIEWER);
    if (parent.space_id !== spaceId) throw new HttpError(400, "parent is in a different space");
  } else {
    await requireSpace(user.id, spaceId, VIEWER);
  }

  // has_grants / has_live_share are computed here, not on the client, so the
  // VISIBILITY column on a folder listing costs zero extra round trips instead
  // of one grants call plus one shares call per row (an N+1 with no bulk
  // endpoint to fall back on). The live-share condition mirrors share.ts's own
  // notion of live exactly: not revoked, and either never-expiring or not yet
  // expired.
  const rows = parentId
    ? await sql`SELECT items.*,
                       EXISTS (SELECT 1 FROM item_grants g WHERE g.item_id = items.id) AS has_grants,
                       EXISTS (SELECT 1 FROM share_links s WHERE s.item_id = items.id
                                 AND s.revoked_at IS NULL
                                 AND (s.expires_at IS NULL OR s.expires_at > now())) AS has_live_share
                  FROM items
                 WHERE parent_id = ${parentId} AND deleted_at IS NULL AND status = 'ready'
                 ORDER BY kind DESC, lower(name)`
    : await sql`SELECT items.*,
                       EXISTS (SELECT 1 FROM item_grants g WHERE g.item_id = items.id) AS has_grants,
                       EXISTS (SELECT 1 FROM share_links s WHERE s.item_id = items.id
                                 AND s.revoked_at IS NULL
                                 AND (s.expires_at IS NULL OR s.expires_at > now())) AS has_live_share
                  FROM items
                 WHERE space_id = ${spaceId} AND parent_id IS NULL
                   AND deleted_at IS NULL AND status = 'ready'
                 ORDER BY kind DESC, lower(name)`;

  return rows.map((r: any) => ({
    ...r, path_ids: parseUuids(r.path_ids), size: r.size === null ? null : Number(r.size),
  })) as Item[];
}

/**
 * Every non-deleted, ready folder in a space, flat — so the move picker can
 * build a full tree in one call instead of walking listChildren level by
 * level (N calls for N levels).
 */
export async function listFolders(user: User, spaceId: string) {
  await requireSpace(user.id, spaceId, VIEWER);
  const rows = await sql`
    SELECT id, name, parent_id, path_ids FROM items
     WHERE space_id = ${spaceId} AND kind = 'folder' AND deleted_at IS NULL AND status = 'ready'
     ORDER BY lower(name)`;
  return rows.map((r: any) => ({ ...r, path_ids: parseUuids(r.path_ids) }));
}

/**
 * Renames and/or moves an item, in ONE transaction.
 *
 * Both halves are applied together because the route exposes them as a single
 * PATCH: a rename that commits before a failing move would leave the caller
 * with half of what they asked for and no way to tell.
 *
 * The move rewrites path_ids for the entire subtree. This is the ONLY place
 * path_ids is mutated. The rewrite replaces the first `depth` elements (the old
 * ancestor chain plus the item itself) with the new ancestor chain, keeping
 * each descendant's own tail intact:
 *
 *   new = newAncestors || old[depth:]
 *
 * For the moved item itself old[depth:] is [item]; for a descendant it is
 * [item, ...rest]. Postgres arrays are 1-indexed, so old[depth:] starts at the
 * item's own position.
 */
export async function patchItem(
  user: User, itemId: string, patch: { name?: string; parent_id?: string | null },
): Promise<Item> {
  const name = patch.name === undefined ? null : checkName(patch.name);
  const moving = patch.parent_id !== undefined;
  const newParentId = patch.parent_id ?? null;

  const item = await requireItem(user.id, itemId, EDITOR);
  if (moving) {
    if (newParentId) {
      if (newParentId === itemId) throw new HttpError(400, "cannot move an item into itself");
      const parent = await requireItem(user.id, newParentId, EDITOR);
      if (parent.kind !== "folder") throw new HttpError(400, "target is not a folder");
      if (parent.space_id !== item.space_id) throw new HttpError(400, "cross-space moves are not supported");
    } else {
      await requireSpace(user.id, item.space_id, EDITOR);
    }
  }

  try {
    await sql.begin(async (tx: any) => {
      if (name !== null) await tx`UPDATE items SET name = ${name} WHERE id = ${itemId}`;
      if (!moving) return;

      // Space-scoped advisory lock, taken BEFORE reading anything the cycle
      // guard is evaluated against. Without it two concurrent moves in the same
      // space each validate against a pre-move tree: moveItem(A,B) and
      // moveItem(B,A) both pass and commit, leaving A.parent=B and B.parent=A —
      // a cycle that hides both subtrees from every listing and that the guard
      // itself then refuses to undo. Held to commit; nothing else in the space
      // can move while we read and write.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${item.space_id}))`;

      let newAncestors: string[] = [];
      if (newParentId) {
        // Re-read under the lock: the target's ancestry as validated above may
        // already be stale, and the guard must run on state that cannot change
        // before the write below.
        const [target] = await tx`SELECT path_ids FROM items
                                   WHERE id = ${newParentId} AND deleted_at IS NULL`;
        if (!target) throw new HttpError(404, "not found");
        newAncestors = parseUuids(target.path_ids);
        // If the target's own path contains this item, the target is a descendant.
        if (newAncestors.includes(itemId))
          throw new HttpError(400, "cannot move a folder into its own descendant");
      }

      // depth MUST come from a read taken inside this transaction, under a row
      // lock. The `item` fetched above (outside the transaction) can be stale
      // by the time we get here: if another moveItem on the same item commits
      // in between, item.path_ids.length no longer matches the row's current
      // path_ids, and path_ids[depth:] would slice at the wrong offset,
      // splicing stale ancestor ids into the item's path. Do not replace this
      // with the outer `item.path_ids.length` — that reintroduces the race.
      const [locked] = await tx`SELECT path_ids FROM items WHERE id = ${itemId} FOR UPDATE`;
      const depth = parseUuids(locked.path_ids).length;
      await tx`UPDATE items SET parent_id = ${newParentId} WHERE id = ${itemId}`;
      await tx`UPDATE items
                  SET path_ids = ${uuids(newAncestors)}::uuid[] || path_ids[${depth}:]
                WHERE path_ids @> ARRAY[${itemId}]::uuid[]`;
    });
  } catch (e) { asConflict(e); }

  return await loadItem(itemId);
}

export async function renameItem(user: User, itemId: string, name: string): Promise<Item> {
  return await patchItem(user, itemId, { name });
}

export async function moveItem(user: User, itemId: string, newParentId: string | null): Promise<void> {
  await patchItem(user, itemId, { parent_id: newParentId });
}
