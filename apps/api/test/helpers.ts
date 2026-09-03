import { sql } from "../src/db.ts";
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

export async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const s = serve(0); // port 0 = pick a free one
  try {
    return await fn(`http://localhost:${s.port}`);
  } finally {
    s.stop(true);
  }
}
