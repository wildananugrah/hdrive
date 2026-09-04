import { beforeEach, expect, test } from "bun:test";
import { addSpaceMember, addSpaceMemberByEmail, createSpace, listSpaceMembers, spaceUsage } from "../src/spaces.ts";
import { EDITOR, VIEWER } from "../src/perm.ts";
import { makeUser, resetDb, seedItem, withServer } from "./helpers.ts";

beforeEach(resetDb);

test("usage sums only ready, non-deleted files in that space", async () => {
  const owner = await makeUser();
  const a = await createSpace(owner as any, "A");
  const b = await createSpace(owner as any, "B");

  await seedItem(a.id, { kind: "file", size: 100, status: "ready" });
  await seedItem(a.id, { kind: "file", size: 50, status: "ready" });
  await seedItem(a.id, { kind: "file", size: 999, status: "pending" }); // not counted
  await seedItem(a.id, { kind: "file", size: 777, status: "ready", deleted: true }); // not counted
  await seedItem(a.id, { kind: "folder", size: null, status: "ready" }); // no size
  await seedItem(b.id, { kind: "file", size: 400, status: "ready" }); // other space

  expect(await spaceUsage(owner as any, a.id)).toEqual({ bytes: 150, items: 2 });
});

test("a non-member gets 404, not an empty total", async () => {
  const owner = await makeUser();
  const stranger = await makeUser();
  const s = await createSpace(owner as any, "Private");
  await expect(Promise.resolve(spaceUsage(stranger as any, s.id))).rejects.toMatchObject({ status: 404 });
});

test("an empty space reports zero, not null", async () => {
  const owner = await makeUser();
  const s = await createSpace(owner as any, "Empty");
  expect(await spaceUsage(owner as any, s.id)).toEqual({ bytes: 0, items: 0 });
});

test("a malformed space id is a 400, not a Postgres error", async () => {
  const owner = await makeUser();
  await expect(Promise.resolve(spaceUsage(owner as any, "not-a-uuid"))).rejects.toMatchObject({ status: 400 });
});

test("adds a member by email, normalizing case and whitespace", async () => {
  const owner = await makeUser();
  const invitee = await makeUser({ email: "person@example.com" });
  const s = await createSpace(owner as any, "S");

  await addSpaceMemberByEmail(owner as any, s.id, "  PERSON@Example.com  ", EDITOR);

  const members = await listSpaceMembers(owner as any, s.id);
  expect(members.find((m: any) => m.subject_id === invitee.id)?.role).toBe(EDITOR);
});

test("an unknown email is 404", async () => {
  const owner = await makeUser();
  const s = await createSpace(owner as any, "S");
  await expect(Promise.resolve(addSpaceMemberByEmail(owner as any, s.id, "nobody@example.com", VIEWER)))
    .rejects.toMatchObject({ status: 404 });
});

test("a non-owner cannot add by email", async () => {
  const owner = await makeUser();
  const viewer = await makeUser();
  const target = await makeUser({ email: "t@example.com" });
  const s = await createSpace(owner as any, "S");
  await addSpaceMember(owner as any, s.id, { type: "user", id: viewer.id }, VIEWER);
  await expect(Promise.resolve(addSpaceMemberByEmail(viewer as any, s.id, "t@example.com", VIEWER)))
    .rejects.toMatchObject({ status: 403 });
});

test("POST members over HTTP: both subject and email, or neither, is 400", async () => {
  const owner = await makeUser();
  const s = await createSpace(owner as any, "S");

  await withServer(async (base) => {
    const headers = { "content-type": "application/json", authorization: `Bearer ${owner.token}` };

    const both = await fetch(`${base}/api/spaces/${s.id}/members`, {
      method: "POST",
      headers,
      body: JSON.stringify({ subject: { type: "user", id: owner.id }, email: "x@example.com", role: "viewer" }),
    });
    expect(both.status).toBe(400);

    const neither = await fetch(`${base}/api/spaces/${s.id}/members`, {
      method: "POST",
      headers,
      body: JSON.stringify({ role: "viewer" }),
    });
    expect(neither.status).toBe(400);
  });
});

test("POST members over HTTP: the email form adds a member, unchanged subject form still works", async () => {
  const owner = await makeUser();
  const bySubject = await makeUser();
  const byEmail = await makeUser({ email: "invitee@example.com" });
  const s = await createSpace(owner as any, "S");

  await withServer(async (base) => {
    const headers = { "content-type": "application/json", authorization: `Bearer ${owner.token}` };

    const r1 = await fetch(`${base}/api/spaces/${s.id}/members`, {
      method: "POST",
      headers,
      body: JSON.stringify({ subject: { type: "user", id: bySubject.id }, role: "viewer" }),
    });
    expect(r1.status).toBe(204);

    const r2 = await fetch(`${base}/api/spaces/${s.id}/members`, {
      method: "POST",
      headers,
      body: JSON.stringify({ email: "invitee@example.com", role: "editor" }),
    });
    expect(r2.status).toBe(204);

    const members = await listSpaceMembers(owner as any, s.id);
    expect(members.find((m: any) => m.subject_id === bySubject.id)?.role).toBe(VIEWER);
    expect(members.find((m: any) => m.subject_id === byEmail.id)?.role).toBe(EDITOR);
  });
});
