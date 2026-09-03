import { sql } from "./db.ts";
import { HttpError, sha256 } from "./http.ts";
import type { User } from "./auth.ts";
import { EDITOR, type Item, loadItem, requireItem } from "./perm.ts";

const DEFAULT_DAYS = 7;

export type ShareMode = "view" | "download";
export type ShareOpts = {
  mode?: ShareMode;
  password?: string;
  /** undefined = 7 days; null = never expires; a number = that many days. */
  expiresInDays?: number | null;
};

const newToken = () =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

/**
 * Only the SHA-256 of the token is stored, so a database dump is not a set of
 * live URLs. The raw token is returned exactly once, here.
 */
export async function createShare(user: User, itemId: string, opts: ShareOpts) {
  const item = await requireItem(user.id, itemId, EDITOR);
  if (item.kind !== "file") throw new HttpError(400, "only files can be shared");

  const mode: ShareMode = opts.mode ?? "view";
  if (mode !== "view" && mode !== "download") throw new HttpError(400, "mode must be view or download");

  const days = opts.expiresInDays === null ? null : (opts.expiresInDays ?? DEFAULT_DAYS);
  if (days !== null && (!Number.isFinite(days) || days <= 0))
    throw new HttpError(400, "expiresInDays must be a positive number or null");
  const expiresAt = days === null ? null : new Date(Date.now() + days * 86400_000);

  const token = newToken();
  const [row] = await sql`
    INSERT INTO share_links (token_hash, item_id, mode, password_hash, expires_at, created_by)
    VALUES (${sha256(token)}, ${itemId}, ${mode},
            ${opts.password ? await Bun.password.hash(opts.password) : null},
            ${expiresAt}, ${user.id})
    RETURNING id, mode, expires_at, created_at`;

  return { ...row, token };
}

export async function listShares(user: User, itemId: string) {
  await requireItem(user.id, itemId, EDITOR);
  return await sql`
    SELECT id, mode, expires_at, revoked_at, created_at,
           (password_hash IS NOT NULL) AS has_password
      FROM share_links WHERE item_id = ${itemId} ORDER BY created_at DESC`;
}

export async function revokeShare(user: User, linkId: string) {
  const [link] = await sql`SELECT item_id FROM share_links WHERE id = ${linkId}`;
  if (!link) throw new HttpError(404, "link not found");
  await requireItem(user.id, link.item_id, EDITOR);
  await sql`UPDATE share_links SET revoked_at = now() WHERE id = ${linkId} AND revoked_at IS NULL`;
}

/**
 * Resolves a public token. No user is involved: the link IS the grant, which is
 * why expiry and revocation are the only brakes and both are checked here.
 * Every rejection is the same 404 so a probe cannot tell "expired" from
 * "never existed".
 */
export async function resolveShare(
  token: string, password?: string,
): Promise<{ link: any; item: Item }> {
  const [link] = await sql`SELECT * FROM share_links WHERE token_hash = ${sha256(token ?? "")}`;
  if (!link || link.revoked_at) throw new HttpError(404, "link not found or expired");
  if (link.expires_at && new Date(link.expires_at) <= new Date())
    throw new HttpError(404, "link not found or expired");

  if (link.password_hash) {
    if (!password || !(await Bun.password.verify(password, link.password_hash)))
      throw new HttpError(401, "password required");
  }

  const item = await loadItem(link.item_id); // throws 404 if trashed
  return { link, item };
}
