import type { Grant, ShareLink } from "../api/types";

export type Visibility = "space" | "shared" | "public";

/**
 * A link is live only if it is neither revoked nor past its expiry.
 * `expires_at === null` means "never expires", which is a deliberate choice a
 * link's creator can make — not a missing value.
 */
export function isLiveShare(s: ShareLink, now: Date = new Date()): boolean {
  if (s.revoked_at) return false;
  if (s.expires_at && new Date(s.expires_at) <= now) return false;
  return true;
}

/**
 * The badge shows the BROADEST exposure, so Public outranks Shared.
 *
 * "Space" is the floor rather than "Private": the backend is grant-only with no
 * deny rules, so every member of a space can see everything in it. An item that
 * is private within a shared space is not representable — see spec §3.
 *
 * For detail views that already hold the full grant/share lists for one item.
 * List rows use `visibilityFromFlags` instead — see below for why, and the
 * agreement test asserting the two never disagree.
 */
export function computeVisibility(input: {
  grants: Grant[];
  shares: ShareLink[];
  now?: Date;
}): Visibility {
  const now = input.now ?? new Date();
  if (input.shares.some((s) => isLiveShare(s, now))) return "public";
  if (input.grants.length > 0) return "shared";
  return "space";
}

/**
 * For list rows: `GET .../children` returns `has_grants`/`has_live_share`
 * precomputed per item so the table never fires a grants call and a shares
 * call per row (an N+1 with no bulk endpoint to escape). Must produce the same
 * tier as `computeVisibility` for every combination — see the agreement test.
 */
export function visibilityFromFlags(flags: { has_grants: boolean; has_live_share: boolean }): Visibility {
  if (flags.has_live_share) return "public";
  if (flags.has_grants) return "shared";
  return "space";
}
