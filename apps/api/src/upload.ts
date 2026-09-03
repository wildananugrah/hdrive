import { parseUuids, sql, uuids } from "./db.ts";
import { HttpError } from "./http.ts";
import type { User } from "./auth.ts";
import { EDITOR, type Item, requireItem, requireSpace } from "./perm.ts";
import { checkName } from "./items.ts";
import { backendFor, writeTarget } from "./backends.ts";

const PRESIGN_SECONDS = 900;

const normalizeMime = (m?: string) =>
  (m || "application/octet-stream").split(";")[0].trim().toLowerCase() || "application/octet-stream";

/**
 * Step 1 of the handshake: reserve the row, choose the backend, hand back a
 * presigned PUT. The row is 'pending' until the object is confirmed to exist,
 * so a browser that never finishes leaves nothing visible behind.
 */
export async function beginUpload(
  user: User, spaceId: string, parentId: string | null, name: string, mime?: string,
) {
  const n = checkName(name);

  let parentPath: string[] = [];
  if (parentId) {
    const parent = await requireItem(user.id, parentId, EDITOR);
    if (parent.kind !== "folder") throw new HttpError(400, "parent is not a folder");
    if (parent.space_id !== spaceId) throw new HttpError(400, "parent is in a different space");
    parentPath = parent.path_ids;
  } else {
    await requireSpace(user.id, spaceId, EDITOR);
  }

  const { id: backendId, backend } = await writeTarget();
  const id = crypto.randomUUID();
  // Server-generated. The user's name never reaches the object key.
  const key = `${spaceId}/${id}`;
  const type = normalizeMime(mime);

  try {
    await sql`
      INSERT INTO items (id, space_id, parent_id, kind, name, path_ids, mime,
                         storage_backend_id, storage_key, status, created_by)
      VALUES (${id}, ${spaceId}, ${parentId}, 'file', ${n},
              ${uuids([...parentPath, id])}::uuid[], ${type},
              ${backendId}, ${key}, 'pending', ${user.id})`;
  } catch (e: any) {
    if (e?.errno === "23505") throw new HttpError(409, "an item with that name already exists here");
    throw e;
  }

  return { item_id: id, url: backend.presignPut(key, type, PRESIGN_SECONDS), expires_in: PRESIGN_SECONDS };
}

/**
 * Step 2: confirm the object landed, then publish the row.
 *
 * Size and mime are read from the storage backend, never accepted from the
 * caller. A client-supplied size would be a quota bypass and a metadata
 * forgery primitive, and this endpoint is reachable by anyone who can upload.
 */
export async function completeUpload(user: User, itemId: string): Promise<Item> {
  const item = await requireItem(user.id, itemId, EDITOR);
  if (item.kind !== "file") throw new HttpError(400, "not a file");
  if (item.status === "ready") return item;

  const backend = await backendFor(item.storage_backend_id!);
  const head = await backend.head(item.storage_key!);
  if (!head) throw new HttpError(400, "no object was uploaded for this item");

  const [row] = await sql`
    UPDATE items SET size = ${head.size}, mime = ${head.mime}, status = 'ready'
     WHERE id = ${itemId} RETURNING *`;
  return { ...row, path_ids: parseUuids(row.path_ids), size: Number(row.size) } as Item;
}
