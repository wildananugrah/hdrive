import { beforeEach, expect, test } from "bun:test";
import { sql } from "../src/db.ts";
import { createBackend, invalidateBackendCache, setWriteTarget } from "../src/backends.ts";
import { beginUpload, completeUpload } from "../src/upload.ts";
import { createSpace, addSpaceMember, grantItem } from "../src/spaces.ts";
import { createFolder } from "../src/items.ts";
import { VIEWER } from "../src/perm.ts";
import { devConfig, makeUser, resetDb } from "./helpers.ts";

beforeEach(async () => { await resetDb(); invalidateBackendCache(); });

async function setup() {
  const owner = await makeUser();
  const space = await createSpace(owner as any, "S");
  const backend = await createBackend({ name: "primary", config: devConfig, makeWriteTarget: true });
  return { owner, spaceId: space.id, backendId: backend.id };
}

const upload = (url: string, body: string, type = "text/plain") =>
  fetch(url, { method: "PUT", body, headers: { "content-type": type } });

test("a full upload round-trip marks the file ready with the real size", async () => {
  const { owner, spaceId } = await setup();
  const { item_id, url } = await beginUpload(owner as any, spaceId, null, "notes.txt", "text/plain");

  const [pending] = await sql`SELECT status, size FROM items WHERE id = ${item_id}`;
  expect(pending.status).toBe("pending");
  expect(pending.size).toBeNull();

  expect((await upload(url, "twelve chars")).status).toBe(200);
  const done = await completeUpload(owner as any, item_id);
  expect(done.status).toBe("ready");
  expect(done.size).toBe(12);
});

test("complete fails when nothing was actually uploaded", async () => {
  const { owner, spaceId } = await setup();
  const { item_id } = await beginUpload(owner as any, spaceId, null, "ghost.txt", "text/plain");
  await expect(completeUpload(owner as any, item_id)).rejects.toMatchObject({ status: 400 });
  const [row] = await sql`SELECT status FROM items WHERE id = ${item_id}`;
  expect(row.status).toBe("pending");
});

test("size comes from storage, not from the client", async () => {
  const { owner, spaceId } = await setup();
  const { item_id, url } = await beginUpload(owner as any, spaceId, null, "real.txt", "text/plain");
  await upload(url, "actually-29-characters-long!!");
  // A client claiming something else must not win: completeUpload takes no size.
  const done = await completeUpload(owner as any, item_id);
  expect(done.size).toBe(29);
});

test("complete is idempotent", async () => {
  const { owner, spaceId } = await setup();
  const { item_id, url } = await beginUpload(owner as any, spaceId, null, "i.txt", "text/plain");
  await upload(url, "abc");
  const a = await completeUpload(owner as any, item_id);
  const b = await completeUpload(owner as any, item_id);
  expect(b.size).toBe(a.size);
  expect(b.status).toBe("ready");
});

test("upload requires EDITOR", async () => {
  const { owner, spaceId } = await setup();
  const viewer = await makeUser();
  await addSpaceMember(owner as any, spaceId, { type: "user", id: viewer.id }, VIEWER);
  await expect(
    beginUpload(viewer as any, spaceId, null, "x.txt", "text/plain"),
  ).rejects.toMatchObject({ status: 403 });
});

test("uploads land in the current write target, and old files keep their own", async () => {
  const { owner, spaceId, backendId: first } = await setup();

  const a = await beginUpload(owner as any, spaceId, null, "old.txt", "text/plain");
  await upload(a.url, "old");
  await completeUpload(owner as any, a.item_id);

  // Admin adds a second backend and switches the write target.
  const second = await createBackend({ name: "secondary", config: devConfig });
  await setWriteTarget(second.id);

  const b = await beginUpload(owner as any, spaceId, null, "new.txt", "text/plain");
  await upload(b.url, "new");
  await completeUpload(owner as any, b.item_id);

  const [oldRow] = await sql`SELECT storage_backend_id FROM items WHERE id = ${a.item_id}`;
  const [newRow] = await sql`SELECT storage_backend_id FROM items WHERE id = ${b.item_id}`;
  expect(oldRow.storage_backend_id).toBe(first);
  expect(newRow.storage_backend_id).toBe(second.id);
});

test("the storage key never contains the user-supplied name", async () => {
  const { owner, spaceId } = await setup();
  const { item_id } = await beginUpload(owner as any, spaceId, null, "../../etc/passwd.txt", "text/plain")
    .catch(() => ({ item_id: null }));
  // the name is rejected outright by checkName
  expect(item_id).toBeNull();

  const ok = await beginUpload(owner as any, spaceId, null, "safe name.txt", "text/plain");
  const [row] = await sql`SELECT storage_key FROM items WHERE id = ${ok.item_id}`;
  expect(row.storage_key).toBe(`${spaceId}/${ok.item_id}`);
});

test("uploading into a folder requires EDITOR on that folder", async () => {
  const { owner, spaceId } = await setup();
  const f = await createFolder(owner as any, spaceId, null, "docs");
  const { item_id } = await beginUpload(owner as any, spaceId, f.id, "in-folder.txt", "text/plain");
  const [row] = await sql`SELECT parent_id FROM items WHERE id = ${item_id}`;
  expect(row.parent_id).toBe(f.id);
});

test("uploading into a folder is refused for a VIEWER on that folder", async () => {
  const { owner, spaceId } = await setup();
  const f = await createFolder(owner as any, spaceId, null, "docs");
  const viewer = await makeUser();
  // VIEWER on the folder specifically, not on the space (which has no membership for viewer at all).
  await grantItem(owner as any, f.id, { type: "user", id: viewer.id }, VIEWER);
  await expect(
    beginUpload(viewer as any, spaceId, f.id, "sneaky.txt", "text/plain"),
  ).rejects.toMatchObject({ status: 403 });
});

test("completeUpload is refused for a VIEWER, even when the object genuinely exists", async () => {
  const { owner, spaceId } = await setup();
  const { item_id, url } = await beginUpload(owner as any, spaceId, null, "shared.txt", "text/plain");
  // Real object in storage and a genuinely pending row, so a passing test here
  // can only be explained by the authorization check, not a missing upload.
  expect((await upload(url, "real bytes")).status).toBe(200);

  const viewer = await makeUser();
  await grantItem(owner as any, item_id, { type: "user", id: viewer.id }, VIEWER);
  await expect(completeUpload(viewer as any, item_id)).rejects.toMatchObject({ status: 403 });

  const [row] = await sql`SELECT status FROM items WHERE id = ${item_id}`;
  expect(row.status).toBe("pending");
});

test("beginUpload fails cleanly when no write target exists", async () => {
  const owner = await makeUser();
  const space = await createSpace(owner as any, "S");
  await expect(
    beginUpload(owner as any, space.id, null, "x.txt", "text/plain"),
  ).rejects.toMatchObject({ status: 503 });
});
