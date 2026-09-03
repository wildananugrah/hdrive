# Hdrive — Design

Date: 2026-09-03
Status: approved (backend); frontend section pending design-file access

## 1. What this is

A team/org drive. Users belong to groups; files and folders live in spaces.
Access is granted, never denied, and inherits down the folder tree. Files are
stored in S3-compatible object storage, with multiple storage backends
configurable by an admin at runtime.

Day one, a user: signs in, opens a space they're a member of, browses folders,
uploads a file, shares a folder with a group, and sends someone a link to a
video that plays in the browser.

## 2. Decisions

| Decision | Choice | Why |
|---|---|---|
| Permission scope | Space role + per-item grants, inherited | Team drive needs both broad and targeted access |
| Grant subject | User **or** group | Group grants for teams, user grants as escape hatch |
| Grant semantics | Grant-only, highest match wins | No deny rules: more grants can only mean more access, which stays auditable |
| Upload path | Presigned direct-to-S3 | Big-bytes path shouldn't cross the app server |
| Download path | Proxied through the API | Permission check must not be bypassable; a presigned GET, once issued, is a bearer credential |
| Auth | Email + password, opaque session tokens in Postgres | Revocable. A file service needs a kill switch that JWT expiry doesn't give |
| Delete | Soft (trash), purge job after 30 days | Restore is the common case |
| Share links | Public token + expiry + optional password + revocation | Permanent unguardable public URLs are the thing you get paged about |

### Explicitly not in v1

- **File versioning.** No version history. Add when users ask to recover an
  overwritten file, which is the signal that it matters.
- **Deny rules on grants.** Ordering and precedence make "why can't I see this?"
  unanswerable. Add only if a real access-revocation case appears that removing
  a grant can't express.
- **Transcoding / HLS.** Progressive MP4 with Range covers a team drive. Adaptive
  bitrate is its own subsystem.
- **Full-text search inside documents.** Name and metadata search only. Add when
  the corpus is big enough that browsing fails.
- **Quotas.** No per-user or per-space limits. The `head()`-verified size is
  recorded, so the data to enforce them exists when needed.

## 3. Architecture

```
hdrive/
  apps/api/            bun http server, Bun.sql, Bun.S3Client
  apps/web/            vite + react
  migrations/          NNNN_name.sql, applied by a small runner
  docker-compose.yml   postgres + minio (dev S3)
```

Two apps, no shared package. Types the frontend needs are hand-written in
`apps/web/src/api.d.ts`. A codegen pipeline for a handful of interfaces costs
more than it saves at this size.

**No ORM.** `Bun.sql` with hand-written SQL. The hardest query in the system is
the permission resolver, and that is a query you want to read as SQL.

**No AWS SDK.** `Bun.S3Client` is built in, accepts a custom `endpoint`, and
presigns natively — which is all the S3-compatible support this needs.

## 4. Data model

```sql
users            (id, email UNIQUE, password_hash, name, is_admin, created_at)
sessions         (id, user_id, expires_at, created_at)
groups           (id, name)
group_members    (group_id, user_id)

spaces           (id, name, created_at)
space_members    (space_id, subject_type, subject_id, role)

items            (id, space_id, parent_id, kind,           -- 'folder' | 'file'
                  name, ancestor_ids uuid[],
                  size, mime, storage_backend_id, storage_key,
                  status,                                   -- 'pending' | 'ready'
                  deleted_at, created_by, created_at)
item_grants      (item_id, subject_type, subject_id, role)

storage_backends (id, name, provider, config jsonb, is_write_target, created_at)
share_links      (id, token_hash, item_id, mode, password_hash,
                  expires_at, revoked_at, created_by, created_at)
```

`subject_type` is `'user' | 'group'`; `subject_id` points at the matching table.

### Three load-bearing choices

**`role` is a smallint** — `viewer=1, editor=2, owner=3`. Because the rule is
"highest match wins", `MAX(role)` *is* the resolver. No CASE ladder, no
application-side comparison, and the ordering can't drift between call sites.

**`ancestor_ids uuid[]`** is a materialized path holding every ancestor id from
root down. Inheritance means a grant on any ancestor counts; the naive
implementation is a recursive CTE on every access check. With the array it's one
indexed predicate (`item_grants.item_id = ANY(item.ancestor_ids)`, GIN index).

The cost is maintenance on move: moving a subtree rewrites the prefix of every
descendant's `ancestor_ids`. That is the only place this representation can go
wrong, so it lives in exactly one function (`moveItem`) and gets a test.

**`storage_backend_id` on each item.** The file row remembers where its bytes
live. `is_write_target` selects the destination for *new* uploads only. Files
uploaded to an older backend keep pointing at it and stay readable, streamable,
and deletable indefinitely. Adding a backend is an INSERT plus a flag flip — no
migration, no data movement, no downtime, nothing existing breaks.

Exactly one backend has `is_write_target = true`; enforced by a partial unique
index.

## 5. Permission resolution

One function. Every read, write, and delete goes through it.

```sql
SELECT MAX(role) FROM (
  SELECT role FROM space_members
   WHERE space_id = $space
     AND (subject_type,subject_id) IN (('user',$me), ('group',ANY($my_groups)))
  UNION ALL
  SELECT role FROM item_grants
   WHERE item_id = ANY($ancestor_ids)
     AND (subject_type,subject_id) IN (('user',$me), ('group',ANY($my_groups)))
) t
```

`NULL` → no access at all. Required roles: read/list = viewer, upload / rename /
move / delete / create-share-link = editor, manage grants = owner.

Admins (`users.is_admin`) bypass this for the admin surface (storage backends,
users, groups, spaces) but **not** for file content — an admin who wants to read
a file grants themselves access, which leaves a row behind.

## 6. Storage abstraction

```ts
interface StorageBackend {
  presignPut(key: string, mime: string): Promise<string>
  getStream(key: string, range?: string): Promise<Response>
  head(key: string): Promise<{ size: number; mime: string } | null>
  delete(key: string): Promise<void>
}
```

One implementation today: `S3Backend`, wrapping `Bun.S3Client`, instantiated per
`storage_backends` row and cached by id. The interface exists because there are N
live instances and provider extensibility was an explicit requirement — not
speculatively.

Object keys are `${space_id}/${item_id}`, generated server-side. Client-supplied
names never touch the key.

**Credentials** live in `config jsonb`, encrypted at rest with `pgcrypto` using a
key from the environment. They are written by the admin UI and never returned to
any client, in any response, including to admins.

## 7. Flows

### Upload

1. `POST /spaces/:id/items` — check editor on parent, pick the write-target
   backend, insert `status='pending'`, return `{ item_id, url }`.
2. Browser `PUT`s directly to the presigned URL.
3. `POST /items/:id/complete` — call `head(key)`. Missing object → 400.

**Size and mime are taken from `head()`, never from the client's completion
call.** A client-supplied size is a quota bypass and a metadata-forgery
primitive; the storage backend is the only trustworthy source.

A sweeper deletes `pending` items older than 24h along with any orphaned object.

### Download and streaming

`GET /items/:id/content` → resolve permission → `getStream(key, req.headers.range)`
→ return with `Content-Range` / `Accept-Ranges` passed through, status `206` when
a range was requested.

Video seeking falls out of implementing downloads correctly. There is no separate
video path, which means video cannot accidentally skip the permission check.

### Share links

`POST /items/:id/share` (editor) → 32 random bytes → **store only the SHA-256**;
return the raw token exactly once. A database dump is therefore not a set of live
URLs.

`GET /s/:token` → look up by hash → reject if revoked or expired → if password-
protected, require it and set a short-lived cookie scoped to that link → stream
through the same `getStream` path.

`mode='view'` sends `Content-Disposition: inline` and the UI hides the download
button. **This is a speed bump, not DRM** — anyone who can view the file can
capture it. The UI must say so, so nobody mistakes it for a control.

Expiry defaults to 7 days. Editors may override, including "never", which the UI
flags visually.

### Trash

`deleted_at` hides the item and keeps it restorable. Deleting a folder is one
statement: `UPDATE items SET deleted_at = now() WHERE ancestor_ids @> ARRAY[:id]`.

The purge job, after 30 days, deletes each object *through that item's own
backend* — which is why per-item `storage_backend_id` matters as much for
deletion as for reads.

### Admin

Storage backend CRUD, write-target flip, and a **"test connection" button that
performs a real put → head → get → delete of a probe key**.

Every S3-compatible provider differs somewhere: path-style vs virtual-host
addressing, CORS configuration, presign clock skew, multipart thresholds. Those
differences should surface when an admin adds the backend, not on a user's first
upload. The probe is the calibration knob a minimal model doesn't see the need
for.

## 8. Frontend

**Pending access to the design project** (`Hdrive.dc.html`, `support.js`).
Requires `/design-login`. This section will be filled in from the actual mockup
rather than invented.

Known regardless: Vite + React, a file browser view, an upload with progress
(direct-to-S3 PUT exposes real progress via `XMLHttpRequest.upload`), a share
dialog, and an admin section for storage backends, users, and groups.

## 9. Testing

`bun test` against Docker Postgres + MinIO. Five that must exist:

1. **Permission resolver truth table** — space role × group grant × ancestor
   grant × no access, exhaustively. This is the security core.
2. **Forged `complete` call** — a client claiming a size/mime that disagrees with
   the stored object must not win.
3. **Share links** — expired, revoked, wrong password, view vs download.
4. **Range requests** — `206` with a correct `Content-Range`.
5. **Multi-backend** — upload to A, add B as write target, assert the file on A
   still reads *and* deletes. This is the stated core requirement, so it gets an
   executable assertion rather than a promise.

Plus one for `moveItem` rewriting `ancestor_ids` across a subtree, since that is
the single place the materialized path can corrupt.

## 10. Risks

- **BiznetGeo CORS.** Direct-to-S3 upload needs `PUT` allowed from the frontend
  origin. If it can't be configured, the fallback is proxying uploads through the
  API — the `StorageBackend` interface absorbs this and nothing else in the design
  changes.
- **Presign clock skew.** S3-compatible providers reject presigned URLs when
  server time drifts. The connection probe catches it at configuration time.
- **`ancestor_ids` on deep moves.** Bounded by one function and one test.
