import { sql, uuids } from "../src/db.ts";
import { login, register } from "../src/auth.ts";
import { serve } from "../src/server.ts";
import type { S3Config } from "../src/storage/s3.ts";

export const devConfig: S3Config = {
  endpoint: process.env.DEV_S3_ENDPOINT!,
  bucket: process.env.DEV_S3_BUCKET!,
  accessKeyId: process.env.DEV_S3_KEY!,
  secretAccessKey: process.env.DEV_S3_SECRET!,
};

/** A genuinely separate bucket (not just a second config on the same one), so
 *  a test can prove an object was deleted from THIS backend and not the other. */
export const devConfig2: S3Config = { ...devConfig, bucket: process.env.DEV_S3_BUCKET2! };

export async function resetDb() {
  await sql`TRUNCATE users, groups, group_members, spaces, space_members,
                     items, item_grants, storage_backends, share_links, sessions
            RESTART IDENTITY CASCADE`;
}

let seq = 0;
export async function makeUser(opts: { admin?: boolean; password?: string } = {}) {
  const email = `u${++seq}-${Date.now()}@test.local`;
  const password = opts.password ?? "hunter2hunter2";
  const user = await register(email, password, `User ${seq}`);
  if (opts.admin) {
    await sql`UPDATE users SET is_admin = true WHERE id = ${user.id}`;
    user.is_admin = true;
  }
  const { token } = await login(email, password);
  return { ...user, token, password };
}

/** Minimal item row for usage/listing tests. A root item (no parent), whose
 *  path_ids is just its own id, matching how items.ts builds path_ids.
 *  created_by is the space's owner, so the FK is satisfied without callers
 *  needing to pass a user. */
export async function seedItem(
  spaceId: string,
  opts: {
    kind?: "file" | "folder";
    size?: number | null;
    status?: "pending" | "ready";
    deleted?: boolean;
  } = {},
) {
  const id = crypto.randomUUID();
  const [row] = await sql`
    INSERT INTO items (id, space_id, parent_id, kind, name, path_ids, size, status,
                       created_by, deleted_at)
    VALUES (${id}, ${spaceId}, NULL, ${opts.kind ?? "file"}, ${`item-${id}`},
            ${uuids([id])}::uuid[], ${opts.size ?? null}, ${opts.status ?? "ready"},
            (SELECT subject_id FROM space_members WHERE space_id = ${spaceId} LIMIT 1),
            ${opts.deleted ? new Date() : null})
    RETURNING *`;
  return row;
}

export async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const s = serve(0); // port 0 = pick a free one
  try {
    return await fn(`http://localhost:${s.port}`);
  } finally {
    s.stop(true);
  }
}
