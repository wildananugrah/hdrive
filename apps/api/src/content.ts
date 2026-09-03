import { HttpError } from "./http.ts";
import type { User } from "./auth.ts";
import { VIEWER, type Item, requireItem } from "./perm.ts";
import { backendFor } from "./backends.ts";

export type Disposition = "inline" | "attachment";

/**
 * Streams an item's bytes, forwarding any Range through to storage.
 *
 * Downloads are proxied rather than presigned so the permission check cannot be
 * bypassed: a presigned GET URL, once issued, works for anyone holding it for
 * as long as it lives. Video seeking is a byproduct of Range support here, so
 * there is no separate video path that could skip this check.
 */
export async function streamItem(
  item: Item, range?: string | null, disposition: Disposition = "attachment",
): Promise<Response> {
  if (item.kind !== "file") throw new HttpError(400, "not a file");
  if (item.status !== "ready") throw new HttpError(409, "this upload has not been completed");

  const backend = await backendFor(item.storage_backend_id!);
  const res = await backend.getStream(item.storage_key!, range);

  const headers = new Headers(res.headers);
  headers.set(
    "content-disposition",
    `${disposition}; filename*=UTF-8''${encodeURIComponent(item.name)}`,
  );
  headers.set("cache-control", "private, max-age=0, must-revalidate");
  // Storage reports the object's own type; the item's recorded mime is the same
  // value (both came from head() at completion), so nothing to reconcile.
  return new Response(res.body, { status: res.status, headers });
}

export async function serveContent(
  user: User, itemId: string, range?: string | null, disposition: Disposition = "attachment",
): Promise<Response> {
  const item = await requireItem(user.id, itemId, VIEWER);
  return streamItem(item, range, disposition);
}
