import { beforeEach, expect, test } from "bun:test";
import { createSpace, spaceUsage } from "../src/spaces.ts";
import { makeUser, resetDb, seedItem } from "./helpers.ts";

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
