import { readdirSync } from "node:fs";
import { join } from "node:path";
import { sql } from "../src/db.ts";

const dir = join(import.meta.dir, "..", "..", "..", "migrations");

await sql`CREATE TABLE IF NOT EXISTS _migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

const applied = new Set(
  (await sql`SELECT name FROM _migrations`).map((r: any) => r.name),
);

const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
let count = 0;

for (const file of files) {
  if (applied.has(file)) continue;
  const body = await Bun.file(join(dir, file)).text();
  await sql.begin(async (tx: any) => {
    await tx.unsafe(body);
    await tx`INSERT INTO _migrations (name) VALUES (${file})`;
  });
  console.log("applied", file);
  count++;
}

console.log(count === 0 ? "already up to date" : `applied ${count} migration(s)`);
await sql.close();
