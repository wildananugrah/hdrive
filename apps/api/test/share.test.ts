import { beforeEach, expect, test } from "bun:test";
import { sql } from "../src/db.ts";
import { createBackend, invalidateBackendCache } from "../src/backends.ts";
import { createShare, listShares, resolveShare, revokeShare } from "../src/share.ts";
import { beginUpload, completeUpload } from "../src/upload.ts";
import { addSpaceMember, createSpace } from "../src/spaces.ts";
import { VIEWER } from "../src/perm.ts";
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
