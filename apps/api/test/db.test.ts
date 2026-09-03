import { expect, test } from "bun:test";
import { parseUuids, sql, uuids } from "../src/db.ts";

test("schema is migrated", async () => {
  const rows = await sql`
    SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public'`;
  const names = rows.map((r: any) => r.table_name);
  for (const t of ["users", "sessions", "groups", "spaces", "items",
                   "item_grants", "storage_backends", "share_links"]) {
    expect(names).toContain(t);
  }
});

test("uuids() round-trips through a uuid[] column", async () => {
  const a = crypto.randomUUID();
  const b = crypto.randomUUID();
  const [row] = await sql`SELECT ${uuids([a, b])}::uuid[] AS ids`;
  expect(parseUuids(row.ids)).toEqual([a, b]);
});

test("uuids([]) matches nothing without erroring", async () => {
  const rows = await sql`SELECT 1 WHERE ${crypto.randomUUID()}::uuid = ANY(${uuids([])}::uuid[])`;
  expect(rows.length).toBe(0);
});

test("uuids() rejects injection at the cast", async () => {
  // Promise.resolve(...) here: passing the raw Bun SQL query (a thenable,
  // not a native Promise) straight to expect(...).rejects hangs bun:test
  // (Bun 1.3.14) instead of resolving the rejection.
  await expect(
    Promise.resolve(
      sql`SELECT 1 WHERE true = ANY(${uuids(["'; DROP TABLE users; --"])}::uuid[])`,
    ),
  ).rejects.toThrow();
  const [{ count }] = await sql`SELECT count(*)::int AS count FROM users`;
  expect(count).toBeGreaterThanOrEqual(0); // table still exists
});

test("only one storage backend may be the write target", async () => {
  await sql`DELETE FROM storage_backends`;
  await sql`INSERT INTO storage_backends (name, config, is_write_target)
            VALUES ('a', '\\x00'::bytea, true)`;
  await expect(
    Promise.resolve(
      sql`INSERT INTO storage_backends (name, config, is_write_target)
          VALUES ('b', '\\x00'::bytea, true)`,
    ),
  ).rejects.toThrow();
  await sql`DELETE FROM storage_backends`;
});
