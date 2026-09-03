# Hdrive Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working Hdrive API — team drive with inherited permissions, multi-backend S3 storage, presigned uploads, range-streaming downloads, and expiring share links.

**Architecture:** A single Bun HTTP server using `Bun.serve`'s built-in route table. Postgres via `Bun.sql` with hand-written SQL migrations, no ORM. Object storage through a four-method `StorageBackend` interface, instantiated once per row in `storage_backends`, so files remember which backend holds their bytes and old backends keep working forever.

**Tech Stack:** Bun 1.3.14 (runtime, HTTP, SQL, S3, password hashing, test runner), PostgreSQL 16, MinIO for local dev S3. **Zero runtime dependencies in `apps/api`.**

**Spec:** `docs/superpowers/specs/2026-09-03-hdrive-design.md`

---

## Global Constraints

- **Bun >= 1.3.14.** Verified present at `/home/wildandev/.bun/bin/bun`.
- **No runtime dependencies in `apps/api`.** Everything comes from Bun builtins: `Bun.serve` (routing), `Bun.sql` (Postgres), `Bun.S3Client` (storage), `Bun.password` (argon2id), `Bun.CryptoHasher` (SHA-256). Adding a package requires justifying why a builtin can't do it.
- **Frontend is out of scope.** `apps/web` is not created by this plan. It gets its own spec once the design file is readable.
- **Ports** (chosen because 5432, 9000, 9001, and 3001 are already occupied on the dev machine): Postgres `5442`, MinIO `9200`/`9201`, API `3011`.
- **Roles are integers**: `VIEWER=1`, `EDITOR=2`, `OWNER=3`. Never compare role names as strings.
- **No access returns 404, not 403.** A 403 confirms an item exists. Only return 403 when the user can already see the item but lacks the level for the specific action.
- **Never trust client-supplied file size or mime.** Both come from the storage backend's `head()`.

---

## Verified Environment Facts

Every item below was executed against real Postgres 16 and MinIO before this plan was written. These are the traps that would otherwise each cost a task cycle. **Do not "fix" code that follows these rules — it looks wrong and is correct.**

**1. `Bun.sql` cannot bind JS arrays to Postgres array columns.**
`sql.array([...])` produces `json[]` (fails `::uuid[]` cast). A plain JS array serializes to `a,b` with no braces (`malformed array literal`). The working form is a literal string plus a cast:

```ts
const uuids = (ids: string[]) => `{${ids.join(",")}}`;
await sql`... WHERE id = ANY(${uuids(ids)}::uuid[])`;
```

This is **injection-safe by construction**: a non-uuid element is rejected by the `::uuid[]` cast (verified with `'; DROP TABLE g3; --`). `uuids([])` yields `{}`, which matches zero rows without erroring — important, because a user in no groups is the common case.

**2. `uuid[]` columns read back as a raw string, not a JS array.**
`SELECT path_ids` returns `"{aaa...,bbb...}"` and `Array.isArray()` is `false`. Every read needs `parseUuids()`.

**3. Multi-statement SQL works three ways.** `sql.unsafe(body)`, `sql.unsafe(body).simple()`, and the same inside `sql.begin()` all succeed. The migration runner can use the plain form.

**4. Postgres errors expose the SQLSTATE on `errno`, not `code`.**
`code` is always `"ERR_POSTGRES_SERVER_ERROR"`. Unique-violation checks must read `e.errno === "23505"`.

**5. `MAX(role)` over zero rows returns `null`**, which is exactly the "no access" signal — no `COALESCE` needed.

**6. Partial unique index enforces one write target.**
`CREATE UNIQUE INDEX ON storage_backends ((true)) WHERE is_write_target` correctly rejects a second row. Consequence: `setWriteTarget` **must** clear the old target before setting the new one, in one transaction.

**7. `Bun.S3Client` specifics:**
- `presign()` is **synchronous** and returns a `string`. Not a promise.
- `stat()` is `head()`; it returns `{etag, lastModified, size, type}`.
- `stat()` on a missing key **throws** `S3Error` with `code === "NoSuchKey"`. Catch only that code — catching all `S3Error` would turn an auth failure into a silent "file missing".
- `delete()` on a missing key does **not** throw. The purge job is safe to retry.
- `file(key).slice(start, end)` maps to an HTTP Range. **`slice`'s end is exclusive; HTTP Range's end is inclusive.** Always `slice(start, end + 1)`.
- `slice(...).stream()` returns a `ReadableStream` of just that range.
- Presigned `PUT` against MinIO returns 200 and works end to end.

**8. `Bun.serve` route params work**, including nested (`/api/items/:id/content`). An unmatched method on a matched route falls through to `fetch`. No HTTP framework needed.

**9. Subtree move by prefix rewrite is verified:**

```sql
UPDATE items SET path_ids = ${uuids(newAncestors)}::uuid[] || path_ids[${depth}:]
 WHERE path_ids @> ARRAY[${itemId}]::uuid[]
```

where `depth = item.path_ids.length`. Confirmed to move a folder and all descendants correctly, leaving unrelated subtrees untouched.

---

## File Structure

```
hdrive/
  docker-compose.yml          postgres:5442, minio:9200/9201
  .env.example
  migrations/
    0001_init.sql             complete schema
  apps/api/
    package.json              scripts only, no deps
    tsconfig.json
    scripts/
      migrate.ts              applies migrations/*.sql in order
      seed-admin.ts           creates the first admin
      jobs.ts                 purge + sweep entrypoint
    src/
      db.ts                   sql client, uuids(), parseUuids()
      http.ts                 HttpError, json(), route(), Req type
      auth.ts                 register/login/logout, requireUser, requireAdmin
      perm.ts                 role constants, effectiveRole, requireItem, requireSpace
      spaces.ts               spaces, groups, membership, item grants
      items.ts                folders, listing, rename, move
      storage/
        index.ts              StorageBackend interface
        s3.ts                 S3Backend over Bun.S3Client
      backends.ts             admin CRUD, encryption, cache, probe, writeTarget
      upload.ts               beginUpload, completeUpload
      content.ts              streamItem, serveContent
      share.ts                createShare, resolveShare, revokeShare
      trash.ts                deleteItem, restoreItem, purgeExpired, sweepPending
      server.ts               Bun.serve route table
    test/
      helpers.ts              resetDb, factories, test server
      *.test.ts
```

One responsibility per file. `perm.ts` is the security core and stays small enough to read in one sitting.

---

## Task Ordering

| Task | Deliverable |
|---|---|
| 1 | Compose stack, schema, migration runner |
| 2 | Auth: register, login, sessions |
| 3 | Permission resolver + spaces/groups/grants |
| 4 | Items: folders, listing, rename, move |
| 5 | Storage backends: adapter, encryption, admin CRUD, probe |
| 6 | Upload handshake |
| 7 | Download + range streaming |
| 8 | Share links |
| 9 | Trash, purge, sweeper |

Tasks 1–4 need no S3. Task 5 is the gate for 6–9.

---

### Task 1: Compose stack, schema, migration runner

**Files:**
- Create: `docker-compose.yml`
- Create: `.env.example`, `.env`
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`
- Create: `migrations/0001_init.sql`
- Create: `apps/api/src/db.ts`
- Create: `apps/api/scripts/migrate.ts`
- Test: `apps/api/test/db.test.ts`

**Interfaces:**
- Produces: `sql` (Bun `SQL` instance), `uuids(ids: string[]): string`, `parseUuids(v: string | null): string[]` — all from `src/db.ts`. Every later task imports these.

- [ ] **Step 1: Write `docker-compose.yml`**

MinIO pre-creates its bucket by making a directory under `/data` — top-level dirs are buckets. This avoids needing an `mc` sidecar container.

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: hdrive
      POSTGRES_PASSWORD: hdrive
      POSTGRES_DB: hdrive
    ports: ["5442:5432"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U hdrive"]
      interval: 2s
      timeout: 3s
      retries: 30
    volumes: ["pgdata:/var/lib/postgresql/data"]

  minio:
    image: minio/minio:latest
    environment:
      MINIO_ROOT_USER: hdrive
      MINIO_ROOT_PASSWORD: hdrive-dev-secret
    entrypoint: sh
    command: -c "mkdir -p /data/hdrive && minio server /data --console-address :9001"
    ports: ["9200:9000", "9201:9001"]
    healthcheck:
      test: ["CMD-SHELL", "curl -sf http://localhost:9000/minio/health/live || exit 1"]
      interval: 2s
      timeout: 3s
      retries: 30
    volumes: ["miniodata:/data"]

volumes:
  pgdata: {}
  miniodata: {}
```

- [ ] **Step 2: Write `.env.example`, then copy it to `.env`**

```
DATABASE_URL=postgres://hdrive:hdrive@localhost:5442/hdrive
STORAGE_CONFIG_KEY=dev-only-change-me-to-32-plus-chars
PORT=3011
COOKIE_SECURE=false

# Local MinIO, used by tests and by seed-backend
DEV_S3_ENDPOINT=http://localhost:9200
DEV_S3_BUCKET=hdrive
DEV_S3_KEY=hdrive
DEV_S3_SECRET=hdrive-dev-secret
```

```bash
cp .env.example .env
```

- [ ] **Step 3: Write `apps/api/package.json`**

```json
{
  "name": "@hdrive/api",
  "private": true,
  "type": "module",
  "scripts": {
    "migrate": "bun run scripts/migrate.ts",
    "dev": "bun --hot src/server.ts",
    "start": "bun src/server.ts",
    "test": "bun test",
    "seed:admin": "bun run scripts/seed-admin.ts",
    "jobs": "bun run scripts/jobs.ts"
  }
}
```

- [ ] **Step 4: Write `apps/api/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun-types"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src", "test", "scripts"]
}
```

- [ ] **Step 5: Write `migrations/0001_init.sql`**

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  name          text NOT NULL,
  is_admin      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- id is the SHA-256 of the session token; the raw token is never stored.
CREATE TABLE sessions (
  id         text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE groups (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE group_members (
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id  uuid NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX group_members_user ON group_members (user_id);

CREATE TABLE spaces (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE subject_kind AS ENUM ('user', 'group');

CREATE TABLE space_members (
  space_id     uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  subject_type subject_kind NOT NULL,
  subject_id   uuid NOT NULL,
  role         smallint NOT NULL CHECK (role BETWEEN 1 AND 3),
  PRIMARY KEY (space_id, subject_type, subject_id)
);

CREATE TABLE storage_backends (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  provider        text NOT NULL DEFAULT 's3',
  config          bytea NOT NULL,          -- pgp_sym_encrypt of a JSON blob
  is_write_target boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);
-- At most one write target. Forces setWriteTarget to clear before it sets.
CREATE UNIQUE INDEX storage_one_write_target
  ON storage_backends ((true)) WHERE is_write_target;

CREATE TABLE items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id           uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  parent_id          uuid REFERENCES items(id) ON DELETE CASCADE,
  kind               text NOT NULL CHECK (kind IN ('folder','file')),
  name               text NOT NULL,
  -- every ancestor id from root, PLUS this item's own id
  path_ids           uuid[] NOT NULL,
  size               bigint,
  mime               text,
  storage_backend_id uuid REFERENCES storage_backends(id),
  storage_key        text,
  status             text NOT NULL DEFAULT 'ready' CHECK (status IN ('pending','ready')),
  deleted_at         timestamptz,
  created_by         uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX items_path_ids ON items USING GIN (path_ids);
CREATE INDEX items_parent   ON items (parent_id) WHERE deleted_at IS NULL;
CREATE INDEX items_space    ON items (space_id)  WHERE deleted_at IS NULL;
CREATE INDEX items_pending  ON items (created_at) WHERE status = 'pending';
CREATE INDEX items_trashed  ON items (deleted_at) WHERE deleted_at IS NOT NULL;

-- No two live siblings with the same name (case-insensitive).
CREATE UNIQUE INDEX items_sibling_name ON items (
  space_id,
  COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
  lower(name)
) WHERE deleted_at IS NULL;

CREATE TABLE item_grants (
  item_id      uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  subject_type subject_kind NOT NULL,
  subject_id   uuid NOT NULL,
  role         smallint NOT NULL CHECK (role BETWEEN 1 AND 3),
  PRIMARY KEY (item_id, subject_type, subject_id)
);

CREATE TABLE share_links (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    text UNIQUE NOT NULL,     -- SHA-256; raw token shown once
  item_id       uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  mode          text NOT NULL CHECK (mode IN ('view','download')),
  password_hash text,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX share_links_item ON share_links (item_id);
```

- [ ] **Step 6: Write `apps/api/src/db.ts`**

```ts
import { SQL } from "bun";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

export const sql = new SQL(url, { max: 10 });

/**
 * Postgres uuid[] literal.
 *
 * Bun serializes JS arrays as `a,b` (no braces) and sql.array() produces
 * json[], neither of which casts to uuid[]. Building the literal is the only
 * form that works. Injection-safe by construction: any element that is not a
 * uuid is rejected by the ::uuid[] cast on the Postgres side.
 *
 * Always use with an explicit cast: ANY(${uuids(ids)}::uuid[])
 */
export const uuids = (ids: string[]) => `{${ids.join(",")}}`;

/** uuid[] columns come back as the raw literal string, not a JS array. */
export const parseUuids = (v: string | string[] | null): string[] => {
  if (Array.isArray(v)) return v;
  if (!v || v === "{}") return [];
  return v.slice(1, -1).split(",").filter(Boolean);
};
```

- [ ] **Step 7: Write `apps/api/scripts/migrate.ts`**

```ts
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
```

- [ ] **Step 8: Start the stack and run the migration**

```bash
docker compose up -d
docker compose ps          # wait until both are healthy
cd apps/api && bun run migrate
```

Expected: `applied 0001_init.sql` then `applied 1 migration(s)`.

- [ ] **Step 9: Write the failing test** — `apps/api/test/db.test.ts`

```ts
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
  await expect(
    sql`SELECT 1 WHERE true = ANY(${uuids(["'; DROP TABLE users; --"])}::uuid[])`,
  ).rejects.toThrow();
  const [{ count }] = await sql`SELECT count(*)::int AS count FROM users`;
  expect(count).toBeGreaterThanOrEqual(0); // table still exists
});

test("only one storage backend may be the write target", async () => {
  await sql`DELETE FROM storage_backends`;
  await sql`INSERT INTO storage_backends (name, config, is_write_target)
            VALUES ('a', '\\x00'::bytea, true)`;
  await expect(
    sql`INSERT INTO storage_backends (name, config, is_write_target)
        VALUES ('b', '\\x00'::bytea, true)`,
  ).rejects.toThrow();
  await sql`DELETE FROM storage_backends`;
});
```

- [ ] **Step 10: Run the tests**

Run: `cd apps/api && bun test test/db.test.ts`
Expected: 5 pass.

- [ ] **Step 11: Commit**

```bash
git add docker-compose.yml .env.example migrations apps/api
git commit -m "feat: compose stack, schema, and migration runner"
```

---

### Task 2: Auth — register, login, sessions

**Files:**
- Create: `apps/api/src/http.ts`
- Create: `apps/api/src/auth.ts`
- Create: `apps/api/src/server.ts`
- Create: `apps/api/test/helpers.ts`
- Test: `apps/api/test/auth.test.ts`

**Interfaces:**
- Consumes: `sql` from `src/db.ts`.
- Produces:
  - `src/http.ts`: `class HttpError { status: number }`, `json(data, status?)`, `route(handler)`, `type Req = Request & { params: Record<string,string> }`, `sha256(s: string): string`
  - `src/auth.ts`: `type User = { id, email, name, is_admin }`, `register(email, password, name): Promise<User>`, `login(email, password): Promise<{ token, user }>`, `logout(token)`, `requireUser(req: Req): Promise<User>`, `requireAdmin(req: Req): Promise<User>`, `sessionCookie(token): string`
  - `test/helpers.ts`: `resetDb()`, `makeUser(overrides?)`, `withServer(fn)`

- [ ] **Step 1: Write `apps/api/src/http.ts`**

```ts
export type Req = Request & { params: Record<string, string> };

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

export const json = (data: unknown, status = 200) => Response.json(data, { status });

export const sha256 = (s: string) =>
  new Bun.CryptoHasher("sha256").update(s).digest("hex");

type Handler = (req: Req) => Promise<Response> | Response;

/** Wraps a route so HttpError becomes a JSON response and nothing else leaks. */
export const route =
  (handler: Handler) =>
  async (req: Req): Promise<Response> => {
    try {
      return await handler(req);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error("unhandled:", e);
      return json({ error: "internal error" }, 500);
    }
  };

export async function body<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}
```

- [ ] **Step 2: Write the failing test** — `apps/api/test/auth.test.ts`

```ts
import { beforeEach, expect, test } from "bun:test";
import { login, register, requireUser } from "../src/auth.ts";
import { HttpError, type Req } from "../src/http.ts";
import { resetDb } from "./helpers.ts";

const asReq = (headers: Record<string, string>) =>
  Object.assign(new Request("http://x/"), { params: {}, headers: new Headers(headers) }) as Req;

beforeEach(resetDb);

test("register creates a user and hashes the password", async () => {
  const u = await register("A@Example.com", "hunter2hunter2", "Ada");
  expect(u.email).toBe("a@example.com");
  expect(u.is_admin).toBe(false);
  expect((u as any).password_hash).toBeUndefined();
});

test("register rejects short passwords and bad emails", async () => {
  await expect(register("a@b.com", "short", "A")).rejects.toThrow(/8 characters/);
  await expect(register("nope", "hunter2hunter2", "A")).rejects.toThrow(/invalid email/);
});

test("register rejects a duplicate email", async () => {
  await register("a@b.com", "hunter2hunter2", "A");
  await expect(register("A@B.com", "hunter2hunter2", "A")).rejects.toThrow(/already registered/);
});

test("login returns a token that authenticates", async () => {
  await register("a@b.com", "hunter2hunter2", "Ada");
  const { token, user } = await login("a@b.com", "hunter2hunter2");
  expect(token.length).toBeGreaterThan(20);
  const me = await requireUser(asReq({ authorization: `Bearer ${token}` }));
  expect(me.id).toBe(user.id);
});

test("login rejects a wrong password and an unknown email identically", async () => {
  await register("a@b.com", "hunter2hunter2", "Ada");
  await expect(login("a@b.com", "wrongwrongwrong")).rejects.toThrow(/invalid credentials/);
  await expect(login("ghost@b.com", "hunter2hunter2")).rejects.toThrow(/invalid credentials/);
});

test("requireUser rejects a missing, malformed, or unknown token", async () => {
  for (const h of [{}, { authorization: "Bearer nope" }, { authorization: "Basic x" }]) {
    await expect(requireUser(asReq(h as any))).rejects.toThrow(HttpError);
  }
});

test("requireUser rejects an expired session", async () => {
  await register("a@b.com", "hunter2hunter2", "Ada");
  const { token } = await login("a@b.com", "hunter2hunter2");
  const { sql } = await import("../src/db.ts");
  const { sha256 } = await import("../src/http.ts");
  await sql`UPDATE sessions SET expires_at = now() - interval '1 hour' WHERE id = ${sha256(token)}`;
  await expect(requireUser(asReq({ authorization: `Bearer ${token}` }))).rejects.toThrow();
});
```

- [ ] **Step 3: Write `apps/api/test/helpers.ts`**

```ts
import { sql } from "../src/db.ts";
import { login, register } from "../src/auth.ts";

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
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd apps/api && bun test test/auth.test.ts`
Expected: FAIL — cannot resolve `../src/auth.ts`.

- [ ] **Step 5: Write `apps/api/src/auth.ts`**

```ts
import { sql } from "./db.ts";
import { HttpError, type Req, sha256 } from "./http.ts";

const SESSION_DAYS = 30;

export type User = { id: string; email: string; name: string; is_admin: boolean };

const newToken = () =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

export async function register(email: string, password: string, name: string): Promise<User> {
  const normalized = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) throw new HttpError(400, "invalid email");
  if (password.length < 8) throw new HttpError(400, "password must be at least 8 characters");
  if (!name.trim()) throw new HttpError(400, "name is required");

  const password_hash = await Bun.password.hash(password); // argon2id
  try {
    const [u] = await sql`
      INSERT INTO users (email, password_hash, name)
      VALUES (${normalized}, ${password_hash}, ${name.trim()})
      RETURNING id, email, name, is_admin`;
    return u as User;
  } catch (e: any) {
    // Postgres exposes SQLSTATE on errno; code is always ERR_POSTGRES_SERVER_ERROR.
    if (e?.errno === "23505") throw new HttpError(409, "email already registered");
    throw e;
  }
}

export async function login(email: string, password: string) {
  const [u] = await sql`
    SELECT id, email, name, is_admin, password_hash FROM users
     WHERE email = ${email.trim().toLowerCase()}`;

  // Same error for unknown email and wrong password: no account enumeration.
  if (!u || !(await Bun.password.verify(password, u.password_hash)))
    throw new HttpError(401, "invalid credentials");

  const token = newToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await sql`INSERT INTO sessions (id, user_id, expires_at)
            VALUES (${sha256(token)}, ${u.id}, ${expires})`;

  const user: User = { id: u.id, email: u.email, name: u.name, is_admin: u.is_admin };
  return { token, user };
}

export async function logout(token: string) {
  await sql`DELETE FROM sessions WHERE id = ${sha256(token)}`;
}

export function tokenFrom(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim() || null;
  const cookie = req.headers.get("cookie") ?? "";
  return cookie.match(/(?:^|;\s*)hd_session=([^;]+)/)?.[1] ?? null;
}

export async function requireUser(req: Req): Promise<User> {
  const token = tokenFrom(req);
  if (!token) throw new HttpError(401, "not authenticated");
  const [row] = await sql`
    SELECT u.id, u.email, u.name, u.is_admin
      FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ${sha256(token)} AND s.expires_at > now()`;
  if (!row) throw new HttpError(401, "not authenticated");
  return row as User;
}

export async function requireAdmin(req: Req): Promise<User> {
  const u = await requireUser(req);
  if (!u.is_admin) throw new HttpError(403, "admin only");
  return u;
}

export function sessionCookie(token: string) {
  const secure = process.env.COOKIE_SECURE === "true" ? "; Secure" : "";
  return `hd_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}

export const clearCookie = "hd_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd apps/api && bun test test/auth.test.ts`
Expected: 7 pass.

- [ ] **Step 7: Write `apps/api/src/server.ts`**

```ts
import { body, json, route, type Req } from "./http.ts";
import { clearCookie, login, logout, register, requireUser, sessionCookie, tokenFrom } from "./auth.ts";

export const routes = {
  "/api/health": { GET: route(async () => json({ ok: true })) },

  "/api/auth/register": {
    POST: route(async (req) => {
      const b = await body<{ email: string; password: string; name: string }>(req);
      return json(await register(b.email, b.password, b.name), 201);
    }),
  },

  "/api/auth/login": {
    POST: route(async (req) => {
      const b = await body<{ email: string; password: string }>(req);
      const { token, user } = await login(b.email, b.password);
      return new Response(JSON.stringify({ user, token }), {
        status: 200,
        headers: { "content-type": "application/json", "set-cookie": sessionCookie(token) },
      });
    }),
  },

  "/api/auth/logout": {
    POST: route(async (req) => {
      const t = tokenFrom(req);
      if (t) await logout(t);
      return new Response(null, { status: 204, headers: { "set-cookie": clearCookie } });
    }),
  },

  "/api/auth/me": { GET: route(async (req) => json(await requireUser(req))) },
};

export function serve(port = Number(process.env.PORT ?? 3011)) {
  return Bun.serve({
    port,
    routes: routes as any,
    fetch: () => json({ error: "not found" }, 404),
  });
}

if (import.meta.main) {
  const s = serve();
  console.log(`hdrive api on http://localhost:${s.port}`);
}
```

- [ ] **Step 8: Add `withServer` to `test/helpers.ts`**

```ts
import { serve } from "../src/server.ts";

export async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const s = serve(0); // port 0 = pick a free one
  try {
    return await fn(`http://localhost:${s.port}`);
  } finally {
    s.stop(true);
  }
}
```

- [ ] **Step 9: Add an HTTP-level test to `test/auth.test.ts`**

```ts
import { withServer } from "./helpers.ts";

test("auth endpoints work over HTTP", async () => {
  await withServer(async (base) => {
    const reg = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "http@b.com", password: "hunter2hunter2", name: "H" }),
    });
    expect(reg.status).toBe(201);

    const li = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "http@b.com", password: "hunter2hunter2" }),
    });
    expect(li.status).toBe(200);
    expect(li.headers.get("set-cookie")).toContain("HttpOnly");
    const { token } = await li.json();

    const me = await fetch(`${base}/api/auth/me`, { headers: { authorization: `Bearer ${token}` } });
    expect(me.status).toBe(200);
    expect((await me.json()).email).toBe("http@b.com");

    const anon = await fetch(`${base}/api/auth/me`);
    expect(anon.status).toBe(401);
  });
});
```

- [ ] **Step 10: Run all tests**

Run: `cd apps/api && bun test`
Expected: all pass.

- [ ] **Step 11: Commit**

```bash
git add apps/api
git commit -m "feat: auth with argon2id passwords and revocable sessions"
```

---

### Task 3: Permission resolver + spaces, groups, grants

This is the security core. Everything else calls into it.

**Files:**
- Create: `apps/api/src/perm.ts`
- Create: `apps/api/src/spaces.ts`
- Modify: `apps/api/src/server.ts` (add space/group routes)
- Test: `apps/api/test/perm.test.ts`

**Interfaces:**
- Consumes: `sql`, `uuids`, `parseUuids` from `db.ts`; `HttpError` from `http.ts`; `User` from `auth.ts`.
- Produces:
  - `src/perm.ts`: `VIEWER=1`, `EDITOR=2`, `OWNER=3`, `type Item`, `groupIdsOf(userId): Promise<string[]>`, `effectiveRole(userId, spaceId, pathIds, groupIds?): Promise<number|null>`, `loadItem(id, opts?): Promise<Item>`, `requireItem(userId, itemId, min, opts?): Promise<Item>`, `requireSpace(userId, spaceId, min): Promise<number>`
  - `src/spaces.ts`: `createSpace(user, name)`, `addSpaceMember(user, spaceId, subject, role)`, `createGroup(user, name)`, `addGroupMember(user, groupId, userId)`, `grantItem(user, itemId, subject, role)`, `revokeItemGrant(user, itemId, subject)`, `listSpaces(userId)`
  - `type Subject = { type: "user" | "group"; id: string }`

- [ ] **Step 1: Write the failing test** — `apps/api/test/perm.test.ts`

The truth table is the point of this task. Every row is a distinct way access can be granted or denied.

```ts
import { beforeEach, expect, test } from "bun:test";
import { sql, uuids } from "../src/db.ts";
import { EDITOR, OWNER, VIEWER, effectiveRole, requireItem, requireSpace } from "../src/perm.ts";
import { makeUser, resetDb } from "./helpers.ts";

beforeEach(resetDb);

/** Builds: space -> /root (folder) -> /root/child (folder) -> /root/child/file */
async function tree(ownerId: string) {
  const [space] = await sql`INSERT INTO spaces (name) VALUES ('S') RETURNING id`;
  const mk = async (parent: any, name: string, kind = "folder") => {
    const id = crypto.randomUUID();
    const path = parent ? [...parent.path, id] : [id];
    await sql`INSERT INTO items (id, space_id, parent_id, kind, name, path_ids, created_by, status)
              VALUES (${id}, ${space.id}, ${parent?.id ?? null}, ${kind}, ${name},
                      ${uuids(path)}::uuid[], ${ownerId}, 'ready')`;
    return { id, path };
  };
  const root = await mk(null, "root");
  const child = await mk(root, "child");
  const file = await mk(child, "file.txt", "file");
  return { spaceId: space.id, root, child, file };
}

const grantSpace = (spaceId: string, t: string, id: string, role: number) =>
  sql`INSERT INTO space_members (space_id, subject_type, subject_id, role)
      VALUES (${spaceId}, ${t}, ${id}, ${role})`;

const grantItem = (itemId: string, t: string, id: string, role: number) =>
  sql`INSERT INTO item_grants (item_id, subject_type, subject_id, role)
      VALUES (${itemId}, ${t}, ${id}, ${role})`;

test("no membership and no grant means no access", async () => {
  const u = await makeUser();
  const t = await tree(u.id);
  expect(await effectiveRole(u.id, t.spaceId, t.file.path)).toBeNull();
});

test("space role applies to every item in the space", async () => {
  const u = await makeUser();
  const t = await tree(u.id);
  await grantSpace(t.spaceId, "user", u.id, VIEWER);
  expect(await effectiveRole(u.id, t.spaceId, t.file.path)).toBe(VIEWER);
  expect(await effectiveRole(u.id, t.spaceId, t.root.path)).toBe(VIEWER);
});

test("a group's space role reaches its members", async () => {
  const u = await makeUser();
  const t = await tree(u.id);
  const [g] = await sql`INSERT INTO groups (name) VALUES ('eng') RETURNING id`;
  await sql`INSERT INTO group_members (group_id, user_id) VALUES (${g.id}, ${u.id})`;
  await grantSpace(t.spaceId, "group", g.id, EDITOR);
  expect(await effectiveRole(u.id, t.spaceId, t.file.path)).toBe(EDITOR);
});

test("an ancestor grant inherits down to a descendant", async () => {
  const u = await makeUser();
  const t = await tree(u.id);
  await grantItem(t.root.id, "user", u.id, EDITOR);
  expect(await effectiveRole(u.id, t.spaceId, t.file.path)).toBe(EDITOR);
});

test("a grant directly on the item resolves (path_ids includes self)", async () => {
  const u = await makeUser();
  const t = await tree(u.id);
  await grantItem(t.file.id, "user", u.id, VIEWER);
  expect(await effectiveRole(u.id, t.spaceId, t.file.path)).toBe(VIEWER);
});

test("a grant on a sibling subtree does NOT leak", async () => {
  const u = await makeUser();
  const t = await tree(u.id);
  await grantItem(t.child.id, "user", u.id, OWNER);
  // child's grant must not reach root, which is its ancestor, not descendant
  expect(await effectiveRole(u.id, t.spaceId, t.root.path)).toBeNull();
});

test("highest role wins across every source", async () => {
  const u = await makeUser();
  const t = await tree(u.id);
  const [g] = await sql`INSERT INTO groups (name) VALUES ('eng') RETURNING id`;
  await sql`INSERT INTO group_members (group_id, user_id) VALUES (${g.id}, ${u.id})`;
  await grantSpace(t.spaceId, "user", u.id, VIEWER);   // low
  await grantSpace(t.spaceId, "group", g.id, EDITOR);  // higher
  await grantItem(t.root.id, "user", u.id, OWNER);     // highest
  expect(await effectiveRole(u.id, t.spaceId, t.file.path)).toBe(OWNER);
});

test("a lower item grant never reduces a higher space role", async () => {
  const u = await makeUser();
  const t = await tree(u.id);
  await grantSpace(t.spaceId, "user", u.id, OWNER);
  await grantItem(t.file.id, "user", u.id, VIEWER);
  expect(await effectiveRole(u.id, t.spaceId, t.file.path)).toBe(OWNER);
});

test("a user in no groups resolves without erroring", async () => {
  const u = await makeUser();
  const t = await tree(u.id);
  expect(await effectiveRole(u.id, t.spaceId, t.file.path)).toBeNull();
});

test("requireItem returns 404 (not 403) when the user has no access at all", async () => {
  const u = await makeUser();
  const t = await tree(u.id);
  await expect(requireItem(u.id, t.file.id, VIEWER)).rejects.toMatchObject({ status: 404 });
});

test("requireItem returns 403 when the user can see it but lacks the level", async () => {
  const u = await makeUser();
  const t = await tree(u.id);
  await grantSpace(t.spaceId, "user", u.id, VIEWER);
  await expect(requireItem(u.id, t.file.id, EDITOR)).rejects.toMatchObject({ status: 403 });
});

test("an admin gets NO implicit access to file content", async () => {
  // Spec §5: admin power is the admin surface (backends, users, groups), not
  // silent read access to everyone's files. An admin who needs a file grants
  // themselves access, which leaves a row behind.
  const u = await makeUser();
  const admin = await makeUser({ admin: true });
  const t = await tree(u.id);
  expect(admin.is_admin).toBe(true);
  expect(await effectiveRole(admin.id, t.spaceId, t.file.path)).toBeNull();
  await expect(requireItem(admin.id, t.file.id, VIEWER)).rejects.toMatchObject({ status: 404 });
});

test("requireSpace resolves with an empty path", async () => {
  const u = await makeUser();
  const t = await tree(u.id);
  await grantSpace(t.spaceId, "user", u.id, EDITOR);
  expect(await requireSpace(u.id, t.spaceId, EDITOR)).toBe(EDITOR);
  await expect(requireSpace(u.id, t.spaceId, OWNER)).rejects.toMatchObject({ status: 403 });
});

test("a deleted item is not loadable by default", async () => {
  const u = await makeUser();
  const t = await tree(u.id);
  await grantSpace(t.spaceId, "user", u.id, OWNER);
  await sql`UPDATE items SET deleted_at = now() WHERE id = ${t.file.id}`;
  await expect(requireItem(u.id, t.file.id, VIEWER)).rejects.toMatchObject({ status: 404 });
  const it = await requireItem(u.id, t.file.id, VIEWER, { includeDeleted: true });
  expect(it.id).toBe(t.file.id);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && bun test test/perm.test.ts`
Expected: FAIL — cannot resolve `../src/perm.ts`.

- [ ] **Step 3: Write `apps/api/src/perm.ts`**

```ts
import { parseUuids, sql, uuids } from "./db.ts";
import { HttpError } from "./http.ts";

export const VIEWER = 1;
export const EDITOR = 2;
export const OWNER = 3;

export const ROLE_NAMES: Record<number, string> = { 1: "viewer", 2: "editor", 3: "owner" };
export const ROLE_VALUES: Record<string, number> = { viewer: 1, editor: 2, owner: 3 };

export function parseRole(name: string): number {
  const r = ROLE_VALUES[name];
  if (!r) throw new HttpError(400, "role must be viewer, editor, or owner");
  return r;
}

export type Item = {
  id: string;
  space_id: string;
  parent_id: string | null;
  kind: "folder" | "file";
  name: string;
  path_ids: string[];
  size: number | null;
  mime: string | null;
  storage_backend_id: string | null;
  storage_key: string | null;
  status: "pending" | "ready";
  deleted_at: string | null;
  created_by: string;
  created_at: string;
};

export async function groupIdsOf(userId: string): Promise<string[]> {
  const rows = await sql`SELECT group_id FROM group_members WHERE user_id = ${userId}`;
  return rows.map((r: any) => r.group_id);
}

/**
 * Effective role = the highest role granted by ANY source:
 *   - the user's own space membership, or one of their groups'
 *   - a grant on the item itself or any ancestor (path_ids includes self)
 *
 * Grant-only: nothing here can lower a role, so more grants can only ever mean
 * more access. Returns null for "no access at all".
 */
export async function effectiveRole(
  userId: string,
  spaceId: string,
  pathIds: string[],
  groupIds?: string[],
): Promise<number | null> {
  const gs = groupIds ?? (await groupIdsOf(userId));
  const [r] = await sql`
    SELECT MAX(role)::int AS role FROM (
      SELECT role FROM space_members
       WHERE space_id = ${spaceId}
         AND ( (subject_type = 'user'  AND subject_id = ${userId})
            OR (subject_type = 'group' AND subject_id = ANY(${uuids(gs)}::uuid[])) )
      UNION ALL
      SELECT role FROM item_grants
       WHERE item_id = ANY(${uuids(pathIds)}::uuid[])
         AND ( (subject_type = 'user'  AND subject_id = ${userId})
            OR (subject_type = 'group' AND subject_id = ANY(${uuids(gs)}::uuid[])) )
    ) t`;
  return r?.role ?? null;
}

export async function loadItem(
  id: string,
  opts: { includeDeleted?: boolean } = {},
): Promise<Item> {
  const [row] = await sql`SELECT * FROM items WHERE id = ${id}`;
  if (!row) throw new HttpError(404, "not found");
  if (row.deleted_at && !opts.includeDeleted) throw new HttpError(404, "not found");
  return { ...row, path_ids: parseUuids(row.path_ids), size: row.size === null ? null : Number(row.size) } as Item;
}

/**
 * Loads an item and asserts the caller has at least `min`.
 *
 * No access at all -> 404, deliberately: a 403 would confirm the item exists to
 * someone who should not know that. 403 is reserved for "you can see it but
 * cannot do this to it".
 */
export async function requireItem(
  userId: string,
  itemId: string,
  min: number,
  opts: { includeDeleted?: boolean } = {},
): Promise<Item> {
  const item = await loadItem(itemId, opts);
  const role = await effectiveRole(userId, item.space_id, item.path_ids);
  if (role === null) throw new HttpError(404, "not found");
  if (role < min) throw new HttpError(403, "forbidden");
  return item;
}

export async function requireSpace(userId: string, spaceId: string, min: number): Promise<number> {
  const role = await effectiveRole(userId, spaceId, []);
  if (role === null) throw new HttpError(404, "not found");
  if (role < min) throw new HttpError(403, "forbidden");
  return role;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && bun test test/perm.test.ts`
Expected: 14 pass.

- [ ] **Step 5: Commit the resolver before adding CRUD around it**

```bash
git add apps/api/src/perm.ts apps/api/test/perm.test.ts
git commit -m "feat: permission resolver with inherited grant-only roles"
```

- [ ] **Step 6: Write `apps/api/src/spaces.ts`**

```ts
import { sql } from "./db.ts";
import { HttpError } from "./http.ts";
import type { User } from "./auth.ts";
import { EDITOR, OWNER, VIEWER, requireItem, requireSpace } from "./perm.ts";

export type Subject = { type: "user" | "group"; id: string };

function checkSubject(s: Subject) {
  if (s?.type !== "user" && s?.type !== "group") throw new HttpError(400, "subject.type must be user or group");
  if (!/^[0-9a-f-]{36}$/i.test(s?.id ?? "")) throw new HttpError(400, "subject.id must be a uuid");
}

/** The creator becomes the space's owner; otherwise nobody could administer it. */
export async function createSpace(user: User, name: string) {
  if (!name?.trim()) throw new HttpError(400, "name is required");
  return await sql.begin(async (tx: any) => {
    const [space] = await tx`INSERT INTO spaces (name) VALUES (${name.trim()}) RETURNING *`;
    await tx`INSERT INTO space_members (space_id, subject_type, subject_id, role)
             VALUES (${space.id}, 'user', ${user.id}, ${OWNER})`;
    return space;
  });
}

export async function listSpaces(userId: string) {
  return await sql`
    SELECT DISTINCT s.id, s.name, s.created_at
      FROM spaces s
      JOIN space_members m ON m.space_id = s.id
     WHERE (m.subject_type = 'user'  AND m.subject_id = ${userId})
        OR (m.subject_type = 'group' AND m.subject_id IN
              (SELECT group_id FROM group_members WHERE user_id = ${userId}))
     ORDER BY s.name`;
}

export async function addSpaceMember(user: User, spaceId: string, subject: Subject, role: number) {
  checkSubject(subject);
  await requireSpace(user.id, spaceId, OWNER);
  await sql`
    INSERT INTO space_members (space_id, subject_type, subject_id, role)
    VALUES (${spaceId}, ${subject.type}, ${subject.id}, ${role})
    ON CONFLICT (space_id, subject_type, subject_id) DO UPDATE SET role = EXCLUDED.role`;
}

export async function removeSpaceMember(user: User, spaceId: string, subject: Subject) {
  checkSubject(subject);
  await requireSpace(user.id, spaceId, OWNER);
  await sql`DELETE FROM space_members
             WHERE space_id = ${spaceId} AND subject_type = ${subject.type} AND subject_id = ${subject.id}`;
}

/** Groups are org-wide, so only admins manage them. */
export async function createGroup(name: string) {
  if (!name?.trim()) throw new HttpError(400, "name is required");
  try {
    const [g] = await sql`INSERT INTO groups (name) VALUES (${name.trim()}) RETURNING *`;
    return g;
  } catch (e: any) {
    if (e?.errno === "23505") throw new HttpError(409, "group already exists");
    throw e;
  }
}

export async function addGroupMember(groupId: string, userId: string) {
  try {
    await sql`INSERT INTO group_members (group_id, user_id) VALUES (${groupId}, ${userId})
              ON CONFLICT DO NOTHING`;
  } catch (e: any) {
    if (e?.errno === "23503") throw new HttpError(404, "group or user not found");
    throw e;
  }
}

export async function removeGroupMember(groupId: string, userId: string) {
  await sql`DELETE FROM group_members WHERE group_id = ${groupId} AND user_id = ${userId}`;
}

/** Managing grants on an item requires OWNER on that item. */
export async function grantItem(user: User, itemId: string, subject: Subject, role: number) {
  checkSubject(subject);
  await requireItem(user.id, itemId, OWNER);
  await sql`
    INSERT INTO item_grants (item_id, subject_type, subject_id, role)
    VALUES (${itemId}, ${subject.type}, ${subject.id}, ${role})
    ON CONFLICT (item_id, subject_type, subject_id) DO UPDATE SET role = EXCLUDED.role`;
}

export async function revokeItemGrant(user: User, itemId: string, subject: Subject) {
  checkSubject(subject);
  await requireItem(user.id, itemId, OWNER);
  await sql`DELETE FROM item_grants
             WHERE item_id = ${itemId} AND subject_type = ${subject.type} AND subject_id = ${subject.id}`;
}

export async function listItemGrants(user: User, itemId: string) {
  await requireItem(user.id, itemId, OWNER);
  return await sql`SELECT subject_type, subject_id, role FROM item_grants WHERE item_id = ${itemId}`;
}
```

- [ ] **Step 7: Add the routes to `apps/api/src/server.ts`**

Insert these entries into the `routes` object, and add the imports at the top:

```ts
import { requireAdmin } from "./auth.ts";
import { parseRole } from "./perm.ts";
import {
  addGroupMember, addSpaceMember, createGroup, createSpace, grantItem,
  listItemGrants, listSpaces, removeGroupMember, removeSpaceMember, revokeItemGrant,
  type Subject,
} from "./spaces.ts";
```

```ts
  "/api/spaces": {
    GET: route(async (req) => json(await listSpaces((await requireUser(req)).id))),
    POST: route(async (req) => {
      const u = await requireUser(req);
      const b = await body<{ name: string }>(req);
      return json(await createSpace(u, b.name), 201);
    }),
  },

  "/api/spaces/:id/members": {
    POST: route(async (req) => {
      const u = await requireUser(req);
      const b = await body<{ subject: Subject; role: string }>(req);
      await addSpaceMember(u, req.params.id, b.subject, parseRole(b.role));
      return new Response(null, { status: 204 });
    }),
    DELETE: route(async (req) => {
      const u = await requireUser(req);
      const b = await body<{ subject: Subject }>(req);
      await removeSpaceMember(u, req.params.id, b.subject);
      return new Response(null, { status: 204 });
    }),
  },

  "/api/groups": {
    POST: route(async (req) => {
      await requireAdmin(req);
      const b = await body<{ name: string }>(req);
      return json(await createGroup(b.name), 201);
    }),
  },

  "/api/groups/:id/members": {
    POST: route(async (req) => {
      await requireAdmin(req);
      const b = await body<{ user_id: string }>(req);
      await addGroupMember(req.params.id, b.user_id);
      return new Response(null, { status: 204 });
    }),
    DELETE: route(async (req) => {
      await requireAdmin(req);
      const b = await body<{ user_id: string }>(req);
      await removeGroupMember(req.params.id, b.user_id);
      return new Response(null, { status: 204 });
    }),
  },

  "/api/items/:id/grants": {
    GET: route(async (req) => json(await listItemGrants(await requireUser(req), req.params.id))),
    POST: route(async (req) => {
      const u = await requireUser(req);
      const b = await body<{ subject: Subject; role: string }>(req);
      await grantItem(u, req.params.id, b.subject, parseRole(b.role));
      return new Response(null, { status: 204 });
    }),
    DELETE: route(async (req) => {
      const u = await requireUser(req);
      const b = await body<{ subject: Subject }>(req);
      await revokeItemGrant(u, req.params.id, b.subject);
      return new Response(null, { status: 204 });
    }),
  },
```

- [ ] **Step 8: Add a spaces test** — append to `apps/api/test/perm.test.ts`

```ts
import { createSpace, listSpaces, addSpaceMember } from "../src/spaces.ts";

test("the space creator becomes its owner", async () => {
  const u = await makeUser();
  const s = await createSpace(u as any, "Marketing");
  expect(await requireSpace(u.id, s.id, OWNER)).toBe(OWNER);
  expect((await listSpaces(u.id)).map((x: any) => x.id)).toContain(s.id);
});

test("only an owner can add space members", async () => {
  const owner = await makeUser();
  const other = await makeUser();
  const s = await createSpace(owner as any, "M");
  await expect(
    addSpaceMember(other as any, s.id, { type: "user", id: other.id }, VIEWER),
  ).rejects.toMatchObject({ status: 404 });

  await addSpaceMember(owner as any, s.id, { type: "user", id: other.id }, VIEWER);
  expect(await requireSpace(other.id, s.id, VIEWER)).toBe(VIEWER);
});

test("adding an existing member updates their role", async () => {
  const owner = await makeUser();
  const other = await makeUser();
  const s = await createSpace(owner as any, "M");
  await addSpaceMember(owner as any, s.id, { type: "user", id: other.id }, VIEWER);
  await addSpaceMember(owner as any, s.id, { type: "user", id: other.id }, EDITOR);
  expect(await requireSpace(other.id, s.id, EDITOR)).toBe(EDITOR);
});
```

- [ ] **Step 9: Run all tests**

Run: `cd apps/api && bun test`
Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add apps/api
git commit -m "feat: spaces, groups, and item grants"
```

---

**Tasks 4–9 continue in `docs/superpowers/plans/2026-09-03-hdrive-backend-part2.md`.**
