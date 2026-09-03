import { beforeEach, expect, test } from "bun:test";
import { sql } from "../src/db.ts";
import { createBackend, invalidateBackendCache } from "../src/backends.ts";
import { createShare, listShares, resolveShare, revokeShare } from "../src/share.ts";
import { beginUpload, completeUpload } from "../src/upload.ts";
import { addSpaceMember, createSpace } from "../src/spaces.ts";
import { EDITOR, VIEWER } from "../src/perm.ts";
import { devConfig, makeUser, resetDb, withServer } from "./helpers.ts";

beforeEach(async () => { await resetDb(); invalidateBackendCache(); });

const CONTENT = "0123456789abcdefghij";

async function uploaded() {
  const owner = await makeUser();
  const space = await createSpace(owner as any, "S");
  await createBackend({ name: "primary", config: devConfig, makeWriteTarget: true });
  const { item_id, url } = await beginUpload(owner as any, space.id, null, "clip.mp4", "video/mp4");
  await fetch(url, { method: "PUT", body: CONTENT, headers: { "content-type": "video/mp4" } });
  await completeUpload(owner as any, item_id);
  return { owner, spaceId: space.id, itemId: item_id };
}

test("the raw token is returned once and only its hash is stored", async () => {
  const { owner, itemId } = await uploaded();
  const link = await createShare(owner as any, itemId, {});
  expect(link.token.length).toBeGreaterThan(20);
  // real entropy, not just a long string: base64url-decodes to a full 32 CSPRNG bytes.
  // Swapping crypto.getRandomValues for Math.random of the same rendered length
  // would fail neither the length check above nor this one on its own — this
  // pins the actual byte count the CSPRNG call produces.
  expect(Buffer.from(link.token, "base64url").length).toBe(32);
  const [row] = await sql`SELECT token_hash FROM share_links WHERE id = ${link.id}`;
  expect(row.token_hash).not.toContain(link.token);
  // the real proof: the stored value IS the sha256 of the token, not merely "different from it"
  const { sha256 } = await import("../src/http.ts");
  expect(row.token_hash).toBe(sha256(link.token));
  // and the plaintext token appears nowhere in the row
  expect(JSON.stringify(row)).not.toContain(link.token);
  // listing never re-exposes it
  expect(JSON.stringify(await listShares(owner as any, itemId))).not.toContain(link.token);
});

test("expiry defaults to 7 days", async () => {
  const { owner, itemId } = await uploaded();
  const link = await createShare(owner as any, itemId, {});
  const days = (new Date(link.expires_at!).getTime() - Date.now()) / 86400_000;
  expect(days).toBeGreaterThan(6.9);
  expect(days).toBeLessThan(7.1);
});

test("an explicit never-expires link is allowed", async () => {
  const { owner, itemId } = await uploaded();
  const link = await createShare(owner as any, itemId, { expiresInDays: null });
  expect(link.expires_at).toBeNull();
  expect((await resolveShare(link.token)).item.id).toBe(itemId);
});

test("a valid token resolves to the item", async () => {
  const { owner, itemId } = await uploaded();
  const link = await createShare(owner as any, itemId, {});
  const { item, link: l } = await resolveShare(link.token);
  expect(item.id).toBe(itemId);
  expect(l.mode).toBe("view");
  // the resolved link never carries either hash, even for a caller that
  // serializes the whole object rather than picking a field off it
  expect(l).not.toHaveProperty("token_hash");
  expect(l).not.toHaveProperty("password_hash");
  expect(JSON.stringify(l)).not.toContain("hash");
});

test("an expired link is rejected", async () => {
  const { owner, itemId } = await uploaded();
  const link = await createShare(owner as any, itemId, {});
  await sql`UPDATE share_links SET expires_at = now() - interval '1 minute' WHERE id = ${link.id}`;
  await expect(resolveShare(link.token)).rejects.toMatchObject({ status: 404 });
});

test("a revoked link is rejected", async () => {
  const { owner, itemId } = await uploaded();
  const link = await createShare(owner as any, itemId, {});
  await revokeShare(owner as any, link.id);
  await expect(resolveShare(link.token)).rejects.toMatchObject({ status: 404 });
});

test("an unknown token is rejected", async () => {
  await expect(resolveShare("not-a-real-token")).rejects.toMatchObject({ status: 404 });
});

test("expired, revoked, and unknown tokens are indistinguishable (same message, same status)", async () => {
  const { owner, itemId } = await uploaded();
  const expired = await createShare(owner as any, itemId, {});
  await sql`UPDATE share_links SET expires_at = now() - interval '1 minute' WHERE id = ${expired.id}`;
  const revoked = await createShare(owner as any, itemId, {});
  await revokeShare(owner as any, revoked.id);

  const results = await Promise.all(
    [expired.token, revoked.token, "not-a-real-token"].map((t) =>
      resolveShare(t).catch((e) => ({ status: e.status, message: e.message })),
    ),
  );
  const [a, b, c] = results as any[];
  expect(a.status).toBe(404);
  expect(b.status).toBe(404);
  expect(c.status).toBe(404);
  expect(a.message).toBe(b.message);
  expect(b.message).toBe(c.message);
});

test("a password-protected link needs the right password", async () => {
  const { owner, itemId } = await uploaded();
  const link = await createShare(owner as any, itemId, { password: "letmein123" });
  await expect(resolveShare(link.token)).rejects.toMatchObject({ status: 401 });
  await expect(resolveShare(link.token, "wrong-one")).rejects.toMatchObject({ status: 401 });
  expect((await resolveShare(link.token, "letmein123")).item.id).toBe(itemId);
});

test("a link to a trashed item stops working", async () => {
  const { owner, itemId } = await uploaded();
  const link = await createShare(owner as any, itemId, {});
  await sql`UPDATE items SET deleted_at = now() WHERE id = ${itemId}`;
  await expect(resolveShare(link.token)).rejects.toMatchObject({ status: 404 });
});

test("a trashed item's link is byte-identical, over HTTP, to an unknown token", async () => {
  const { owner, itemId } = await uploaded();
  const link = await createShare(owner as any, itemId, {});
  await sql`UPDATE items SET deleted_at = now() WHERE id = ${itemId}`;

  await withServer(async (base) => {
    const trashed = await fetch(`${base}/s/${link.token}`);
    const unknown = await fetch(`${base}/s/not-a-real-token`);
    expect(trashed.status).toBe(unknown.status);
    expect(trashed.status).toBe(404);
    expect(await trashed.text()).toBe(await unknown.text());
  });
});

test("any EDITOR can create a link; a VIEWER cannot", async () => {
  const { owner, spaceId, itemId } = await uploaded();
  const viewer = await makeUser();
  await addSpaceMember(owner as any, spaceId, { type: "user", id: viewer.id }, VIEWER);
  // sanity: the viewer genuinely has VIEWER (not merely "no access", which would
  // also 404/403 for the wrong reason) — they can read the item they were just granted.
  const [row] = await sql`SELECT role FROM space_members WHERE space_id = ${spaceId} AND subject_id = ${viewer.id}`;
  expect(row.role).toBe(VIEWER);
  await expect(createShare(viewer as any, itemId, {})).rejects.toMatchObject({ status: 403 });
});

test("listShares refuses a user with no access to the item", async () => {
  const { itemId } = await uploaded();
  const stranger = await makeUser(); // never added to the space or granted on the item
  await expect(listShares(stranger as any, itemId)).rejects.toMatchObject({ status: 404 });
});

test("revokeShare refuses a VIEWER on someone else's link", async () => {
  const { owner, spaceId, itemId } = await uploaded();
  const link = await createShare(owner as any, itemId, {});
  const viewer = await makeUser();
  await addSpaceMember(owner as any, spaceId, { type: "user", id: viewer.id }, VIEWER);
  await expect(revokeShare(viewer as any, link.id)).rejects.toMatchObject({ status: 403 });
  // and it genuinely wasn't revoked
  const [row] = await sql`SELECT revoked_at FROM share_links WHERE id = ${link.id}`;
  expect(row.revoked_at).toBeNull();
});

test("revokeShare succeeds for an EDITOR", async () => {
  const { owner, spaceId, itemId } = await uploaded();
  const link = await createShare(owner as any, itemId, {});
  const editor = await makeUser();
  await addSpaceMember(owner as any, spaceId, { type: "user", id: editor.id }, EDITOR);
  await revokeShare(editor as any, link.id);
  const [row] = await sql`SELECT revoked_at FROM share_links WHERE id = ${link.id}`;
  expect(row.revoked_at).not.toBeNull();
});

test("createShare rejects an empty-string password instead of silently creating an unprotected link", async () => {
  const { owner, itemId } = await uploaded();
  await expect(createShare(owner as any, itemId, { password: "" })).rejects.toMatchObject({ status: 400 });
});

test("createShare rejects a non-string password over HTTP with 400, not 500", async () => {
  const { owner, itemId } = await uploaded();
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/items/${itemId}/shares`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ password: 12345 }),
    });
    expect(res.status).toBe(400);
  });
});

test("the public route streams, honours Range, and respects view mode", async () => {
  const { owner, itemId } = await uploaded();
  const view = await createShare(owner as any, itemId, { mode: "view" });
  const dl = await createShare(owner as any, itemId, { mode: "download" });

  await withServer(async (base) => {
    const r = await fetch(`${base}/s/${view.token}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toStartWith("inline");
    expect(await r.text()).toBe(CONTENT);

    // seeking a shared video with no login
    const seek = await fetch(`${base}/s/${view.token}`, { headers: { range: "bytes=3-7" } });
    expect(seek.status).toBe(206);
    expect(await seek.text()).toBe("34567");

    const d = await fetch(`${base}/s/${dl.token}`);
    expect(d.headers.get("content-disposition")).toStartWith("attachment");

    const bad = await fetch(`${base}/s/nope`);
    expect(bad.status).toBe(404);
  });
});

test("a password-protected link unlocks via a cookie, never a query string", async () => {
  const { owner, itemId } = await uploaded();
  const link = await createShare(owner as any, itemId, { password: "letmein123" });
  const other = await createShare(owner as any, itemId, { password: "letmein123" });

  await withServer(async (base) => {
    // no cookie yet: refused
    const bare = await fetch(`${base}/s/${link.token}`);
    expect(bare.status).toBe(401);

    // the old query-string path is gone: a correct password in the URL does nothing
    const viaQuery = await fetch(`${base}/s/${link.token}?password=letmein123`);
    expect(viaQuery.status).toBe(401);

    // wrong password: 401, and no cookie is set
    const wrong = await fetch(`${base}/s/${link.token}/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "nope" }),
    });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();

    // right password: 204 and a cookie is set
    const unlock = await fetch(`${base}/s/${link.token}/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "letmein123" }),
    });
    expect(unlock.status).toBe(204);
    const setCookie = unlock.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain(`Path=/s/${link.token}`);
    const cookiePair = setCookie!.split(";")[0];

    // with the cookie: streams
    const withCookie = await fetch(`${base}/s/${link.token}`, { headers: { cookie: cookiePair } });
    expect(withCookie.status).toBe(200);
    expect(await withCookie.text()).toBe(CONTENT);

    // that same cookie does not unlock a DIFFERENT link, even password-protected with the same password
    const wrongLink = await fetch(`${base}/s/${other.token}`, { headers: { cookie: cookiePair } });
    expect(wrongLink.status).toBe(401);
  });
});

test("unlocking a link that has no password is a no-op: no cookie, GET still works", async () => {
  const { owner, itemId } = await uploaded();
  const link = await createShare(owner as any, itemId, {});
  await withServer(async (base) => {
    const unlock = await fetch(`${base}/s/${link.token}/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "irrelevant" }),
    });
    expect(unlock.status).toBe(204);
    expect(unlock.headers.get("set-cookie")).toBeNull();
    const r = await fetch(`${base}/s/${link.token}`);
    expect(r.status).toBe(200);
  });
});
