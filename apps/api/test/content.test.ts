import { beforeEach, expect, test } from "bun:test";
import { invalidateBackendCache, createBackend } from "../src/backends.ts";
import { serveContent } from "../src/content.ts";
import { beginUpload, completeUpload } from "../src/upload.ts";
import { createFolder } from "../src/items.ts";
import { addSpaceMember, createSpace } from "../src/spaces.ts";
import { VIEWER } from "../src/perm.ts";
import { devConfig, makeUser, resetDb, withServer } from "./helpers.ts";

beforeEach(async () => { await resetDb(); invalidateBackendCache(); });

const CONTENT = "0123456789abcdefghij"; // 20 bytes

async function uploaded(name = "clip.mp4", mime = "video/mp4") {
  const owner = await makeUser();
  const space = await createSpace(owner as any, "S");
  await createBackend({ name: "primary", config: devConfig, makeWriteTarget: true });
  const { item_id, url } = await beginUpload(owner as any, space.id, null, name, mime);
  await fetch(url, { method: "PUT", body: CONTENT, headers: { "content-type": mime } });
  await completeUpload(owner as any, item_id);
  return { owner, spaceId: space.id, itemId: item_id };
}

test("a full download returns the whole object", async () => {
  const { owner, itemId } = await uploaded();
  const r = await serveContent(owner as any, itemId);
  expect(r.status).toBe(200);
  expect(await r.text()).toBe(CONTENT);
  expect(r.headers.get("accept-ranges")).toBe("bytes");
});

test("a range request returns 206 with the right slice — video seeking", async () => {
  const { owner, itemId } = await uploaded();
  const r = await serveContent(owner as any, itemId, "bytes=5-9");
  expect(r.status).toBe(206);
  expect(r.headers.get("content-range")).toBe("bytes 5-9/20");
  expect(r.headers.get("content-length")).toBe("5");
  expect(await r.text()).toBe("56789");
});

test("content-disposition carries the item name, not the storage key", async () => {
  const { owner, itemId } = await uploaded("Quarterly Report.pdf", "application/pdf");
  const r = await serveContent(owner as any, itemId, null, "attachment");
  expect(r.headers.get("content-disposition")).toContain("Quarterly%20Report.pdf");
  expect(r.headers.get("content-disposition")).toStartWith("attachment");
});

test("inline disposition is used for viewing", async () => {
  const { owner, itemId } = await uploaded();
  const r = await serveContent(owner as any, itemId, null, "inline");
  expect(r.headers.get("content-disposition")).toStartWith("inline");
});

test("a user without access gets 404, not the bytes", async () => {
  const { itemId } = await uploaded();
  const stranger = await makeUser();
  await expect(serveContent(stranger as any, itemId)).rejects.toMatchObject({ status: 404 });
});

test("a VIEWER can download", async () => {
  const { owner, spaceId, itemId } = await uploaded();
  const viewer = await makeUser();
  await addSpaceMember(owner as any, spaceId, { type: "user", id: viewer.id }, VIEWER);
  expect((await serveContent(viewer as any, itemId)).status).toBe(200);
});

test("a pending upload cannot be downloaded", async () => {
  const owner = await makeUser();
  const space = await createSpace(owner as any, "S");
  await createBackend({ name: "primary", config: devConfig, makeWriteTarget: true });
  const { item_id } = await beginUpload(owner as any, space.id, null, "half.txt", "text/plain");
  await expect(serveContent(owner as any, item_id)).rejects.toMatchObject({ status: 409 });
});

test("a folder cannot be downloaded as content", async () => {
  const owner = await makeUser();
  const space = await createSpace(owner as any, "S");
  const folder = await createFolder(owner as any, space.id, null, "Docs");
  await expect(serveContent(owner as any, folder.id)).rejects.toMatchObject({ status: 400 });
});

test("range streaming works end to end over HTTP", async () => {
  const { owner, itemId } = await uploaded();
  await withServer(async (base) => {
    const r = await fetch(`${base}/api/items/${itemId}/content`, {
      headers: { authorization: `Bearer ${owner.token}`, range: "bytes=10-14" },
    });
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe("bytes 10-14/20");
    expect(await r.text()).toBe("abcde");
  });
});

test("an unauthenticated content request is rejected", async () => {
  const { itemId } = await uploaded();
  await withServer(async (base) => {
    const r = await fetch(`${base}/api/items/${itemId}/content`);
    expect(r.status).toBe(401);
  });
});
