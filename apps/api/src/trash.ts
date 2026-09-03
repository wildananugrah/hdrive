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
 * delete() is idempotent, so a partial run is safe to repeat. A row whose
 * storage delete fails is left alone (not counted, not deleted) so the next
 * run retries it -- deleting the row first would orphan the object forever.
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
