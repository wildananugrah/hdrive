import { createHmac, timingSafeEqual } from "node:crypto";
import { sql } from "./db.ts";
import { HttpError, sha256 } from "./http.ts";
import type { User } from "./auth.ts";
import { EDITOR, type Item, loadItem, requireItem } from "./perm.ts";

const DEFAULT_DAYS = 7;
const UNLOCK_COOKIE = "hd_share_unlock";
const UNLOCK_TTL_SECONDS = 15 * 60;

export type ShareMode = "view" | "download";
export type ShareOpts = {
  mode?: ShareMode;
  password?: string;
  /** undefined = 7 days; null = never expires; a number = that many days. */
  expiresInDays?: number | null;
};

const newToken = () =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

function checkPassword(password: unknown): string | undefined {
  if (password === undefined) return undefined;
  if (typeof password !== "string" || password.length === 0)
    throw new HttpError(400, "password must be a non-empty string");
  return password;
}

/**
 * Only the SHA-256 of the token is stored, so a database dump is not a set of
 * live URLs. The raw token is returned exactly once, here.
 */
export async function createShare(user: User, itemId: string, opts: ShareOpts) {
  const item = await requireItem(user.id, itemId, EDITOR);
  if (item.kind !== "file") throw new HttpError(400, "only files can be shared");
  // A pending row has no object behind it yet. Sharing it would hand out a link
  // whose only possible answer discriminates the item's state to a stranger.
  if (item.status !== "ready") throw new HttpError(400, "only completed uploads can be shared");

  const mode: ShareMode = opts.mode ?? "view";
  if (mode !== "view" && mode !== "download") throw new HttpError(400, "mode must be view or download");

  const days = opts.expiresInDays === null ? null : (opts.expiresInDays ?? DEFAULT_DAYS);
  if (days !== null && (!Number.isFinite(days) || days <= 0))
    throw new HttpError(400, "expiresInDays must be a positive number or null");
  const expiresAt = days === null ? null : new Date(Date.now() + days * 86400_000);

  const password = checkPassword(opts.password);
  const token = newToken();
  const [row] = await sql`
    INSERT INTO share_links (token_hash, item_id, mode, password_hash, expires_at, created_by)
    VALUES (${sha256(token)}, ${itemId}, ${mode},
            ${password ? await Bun.password.hash(password) : null},
            ${expiresAt}, ${user.id})
    RETURNING id, mode, expires_at, created_at`;

  return { ...row, token };
}

// includeDeleted: a link on a trashed file must stay listable and revocable.
// Otherwise the only way to kill it is to restore the file first — and a restore
// silently revives the link.
export async function listShares(user: User, itemId: string) {
  await requireItem(user.id, itemId, EDITOR, { includeDeleted: true });
  return await sql`
    SELECT id, mode, expires_at, revoked_at, created_at,
           (password_hash IS NOT NULL) AS has_password
      FROM share_links WHERE item_id = ${itemId} ORDER BY created_at DESC`;
}

export async function revokeShare(user: User, linkId: string) {
  const [link] = await sql`SELECT item_id FROM share_links WHERE id = ${linkId}`;
  if (!link) throw new HttpError(404, "link not found");
  await requireItem(user.id, link.item_id, EDITOR, { includeDeleted: true });
  await sql`UPDATE share_links SET revoked_at = now() WHERE id = ${linkId} AND revoked_at IS NULL`;
}

type LinkRow = {
  id: string; item_id: string; mode: ShareMode;
  password_hash: string | null; token_hash: string;
  expires_at: string | null; revoked_at: string | null; created_at: string;
};

/** Fields safe to hand back to a caller — never token_hash or password_hash,
 *  so a future caller that serializes `link` whole can't ship a hash either. */
function publicLink(link: LinkRow) {
  return { id: link.id, item_id: link.item_id, mode: link.mode, expires_at: link.expires_at, created_at: link.created_at };
}

/**
 * Fetches a link by its raw token and checks the only two brakes that apply
 * to a public credential: revocation and expiry. Every rejection here is the
 * SAME 404, so a probe cannot tell "expired" from "revoked" from "never existed".
 */
async function loadLink(token: string): Promise<LinkRow> {
  const [link] = await sql`SELECT * FROM share_links WHERE token_hash = ${sha256(token ?? "")}`;
  if (!link || link.revoked_at) throw new HttpError(404, "link not found or expired");
  if (link.expires_at && new Date(link.expires_at) <= new Date())
    throw new HttpError(404, "link not found or expired");
  return link as LinkRow;
}

/**
 * Loads the item behind a link and folds "trashed" — and every other state that
 * cannot be streamed — into the SAME 404 as every rejection in loadLink.
 * Without this, a stale-token holder could tell "the link is fine but the item
 * was deleted / never finished uploading" apart from "the link itself is dead"
 * — the exact discrimination a public token must not leak. (streamItem's own
 * 409 for a pending upload is precisely that leak, so the state is checked here
 * instead of being allowed to reach it.)
 */
async function loadLiveItem(itemId: string): Promise<Item> {
  const dead = () => new HttpError(404, "link not found or expired");
  const item = await loadItem(itemId).catch(() => { throw dead(); });
  if (item.kind !== "file" || item.status !== "ready") throw dead();
  return item;
}

/**
 * Resolves a public token with a password supplied directly as an argument
 * (not over HTTP as a query string — see resolveSharePublic for the route
 * that actually serves GET /s/:token, which authenticates via a cookie so
 * the password never has to travel in a URL).
 */
export async function resolveShare(
  token: string, password?: string,
): Promise<{ link: ReturnType<typeof publicLink>; item: Item }> {
  const link = await loadLink(token);
  if (link.password_hash) {
    if (!password || !(await Bun.password.verify(password, link.password_hash)))
      throw new HttpError(401, "password required");
  }
  const item = await loadLiveItem(link.item_id);
  return { link: publicLink(link), item };
}

/**
 * ponytail: the unlock cookie is HMAC-signed with STORAGE_CONFIG_KEY — already
 * a required server secret — rather than a dedicated one, to avoid another env
 * var for a single 15-minute cookie. Upgrade path: a separate
 * SHARE_UNLOCK_SECRET if key separation across purposes ever matters.
 */
const UNLOCK_SECRET = process.env.STORAGE_CONFIG_KEY!;

function signUnlock(tokenHash: string, expiresAtMs: number): string {
  const mac = createHmac("sha256", UNLOCK_SECRET).update(`${tokenHash}.${expiresAtMs}`).digest("hex");
  return `${expiresAtMs}.${mac}`;
}

/** Recomputes the HMAC bound to THIS link's token_hash, so a cookie minted for
 *  one link can never unlock another, even if it were somehow attached to the
 *  wrong request. Constant-time compare against a forged MAC. */
function verifyUnlock(tokenHash: string, cookieValue: string | null | undefined): boolean {
  if (!cookieValue) return false;
  const [expStr, mac] = cookieValue.split(".");
  const expiresAtMs = Number(expStr);
  if (!mac || !Number.isFinite(expiresAtMs) || expiresAtMs < Date.now()) return false;
  const expected = createHmac("sha256", UNLOCK_SECRET).update(`${tokenHash}.${expiresAtMs}`).digest("hex");
  const a = Buffer.from(mac, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function readUnlockCookie(cookieHeader: string | null): string | undefined {
  return cookieHeader?.match(new RegExp(`(?:^|;\\s*)${UNLOCK_COOKIE}=([^;]+)`))?.[1];
}

/** Set-Cookie for a successful unlock: HttpOnly (never readable by page JS),
 *  and path-scoped to this one link's URL so a browser never attaches it to
 *  any other share. */
export function unlockCookieHeader(token: string, value: string): string {
  const secure = process.env.COOKIE_SECURE === "true" ? "; Secure" : "";
  return `${UNLOCK_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/s/${encodeURIComponent(token)}; Max-Age=${UNLOCK_TTL_SECONDS}${secure}`;
}

/**
 * Verifies a link's password and hands back the unlock-cookie value.
 * Nothing is stored server-side for this: the cookie itself is a signed,
 * time-boxed, link-bound marker (see signUnlock/verifyUnlock), so checking it
 * on the way back in is a pure recompute-and-compare — no session table to
 * manage or expire.
 */
export async function unlockShare(
  token: string, password: string,
): Promise<{ cookieValue: string | null }> {
  const link = await loadLink(token);
  if (!link.password_hash) return { cookieValue: null }; // nothing to unlock
  if (!password || !(await Bun.password.verify(password, link.password_hash)))
    throw new HttpError(401, "password required");
  return { cookieValue: signUnlock(link.token_hash, Date.now() + UNLOCK_TTL_SECONDS * 1000) };
}

/**
 * Serves GET /s/:token: authenticates a password-protected link via the
 * unlock cookie instead of a password argument, so the secret never travels
 * in the URL (query strings land in access logs, proxy logs, browser
 * history, and the Referer header on any subresource).
 */
export async function resolveSharePublic(
  token: string, unlockCookie?: string | null,
): Promise<{ link: ReturnType<typeof publicLink>; item: Item }> {
  const link = await loadLink(token);
  if (link.password_hash && !verifyUnlock(link.token_hash, unlockCookie)) {
    throw new HttpError(401, "password required");
  }
  const item = await loadLiveItem(link.item_id);
  return { link: publicLink(link), item };
}
