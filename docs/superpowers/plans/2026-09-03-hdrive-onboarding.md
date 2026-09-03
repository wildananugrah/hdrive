# Hdrive Onboarding Cycle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Hdrive usable by more than one person — admins create users, anyone creates spaces, owners manage space membership, admins manage group membership.

**Architecture:** Two small backend additions (a live usage query and an email form for adding members), then five frontend screens that call API endpoints which already exist. No schema changes.

**Tech Stack:** Bun + `Bun.sql` (Postgres) on the API; Vite + React + TypeScript + React Router + TanStack Query v5 on the web; Vitest + React Testing Library; Playwright for end-to-end.

**Spec:** `docs/superpowers/specs/2026-09-03-hdrive-onboarding-design.md`

## Global Constraints

- `apps/api` has **zero runtime dependencies**. No ORM, no HTTP framework, no AWS SDK. Bun builtins only.
- No access is **404, never 403**. The three `/admin/*` routes are the deliberate exception and 403, because the sidebar already reveals they exist.
- Roles are integers internally (`VIEWER=1`, `EDITOR=2`, `OWNER=3`) and wire strings externally (`"viewer"`, `"editor"`, `"owner"`).
- Every list branches on `isError` **explicitly, before** any empty check. React Query v5 settles `isPending` to false on error too, so `if (isPending) … if (!data?.length)` reports a server fault as an empty result. This caused four defects in the previous cycle.
- No hardcoded colours anywhere, including `.tsx`. Use the custom properties in `src/styles/tokens.css`.
- Passwords and tokens never enter `localStorage`, `sessionStorage`, a URL, or the console.
- Append to `src/api/queries.ts`; never rewrite it.
- `bun test` in `apps/api` TRUNCATEs the database. Never run it while e2e fixtures are seeded.

## File Structure

**Backend**
- Modify `apps/api/src/spaces.ts` — add `spaceUsage()`, extend `addSpaceMember` to resolve an email.
- Modify `apps/api/src/server.ts` — add `GET /api/spaces/:id/usage`; widen the members POST body.
- Modify `apps/api/test/spaces.test.ts` — new cases.

**Frontend**
- `src/api/queries.ts` — append `useCreateUser`, `useCreateSpace`, `useSpaceUsage`, `useAddSpaceMember`, `useUpdateSpaceMemberRole`, `useRemoveSpaceMember`, `useGroupMembers`, `useAddGroupMember`, `useRemoveGroupMember`.
- `src/components/CreateSpaceModal.tsx` — new.
- `src/components/StorageMeter.tsx` — new.
- `src/routes/SpaceMembers.tsx` — new.
- Modify `src/routes/admin/Users.tsx`, `src/routes/admin/Groups.tsx`, `src/routes/SpaceRedirect.tsx`, `src/components/Sidebar.tsx`, `src/App.tsx`.

---

### Task 1: Backend — space usage endpoint

**Files:**
- Modify: `apps/api/src/spaces.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/test/spaces.test.ts`

**Interfaces:**
- Produces: `spaceUsage(user: User, spaceId: string): Promise<{ bytes: number; items: number }>`, served at `GET /api/spaces/:id/usage`.

- [ ] **Step 1: Write the failing test**

In `apps/api/test/spaces.test.ts`:

```ts
test("usage sums only ready, non-deleted files in that space", async () => {
  const owner = await makeUser();
  const a = await createSpace(owner, "A");
  const b = await createSpace(owner, "B");

  await seedItem(a.id, { kind: "file", size: 100, status: "ready" });
  await seedItem(a.id, { kind: "file", size: 50,  status: "ready" });
  await seedItem(a.id, { kind: "file", size: 999, status: "pending" });        // not counted
  await seedItem(a.id, { kind: "file", size: 777, status: "ready", deleted: true }); // not counted
  await seedItem(a.id, { kind: "folder", size: null, status: "ready" });       // no size
  await seedItem(b.id, { kind: "file", size: 400, status: "ready" });          // other space

  expect(await spaceUsage(owner, a.id)).toEqual({ bytes: 150, items: 2 });
});

test("a non-member gets 404, not an empty total", async () => {
  const owner = await makeUser();
  const stranger = await makeUser();
  const s = await createSpace(owner, "Private");
  await expect(Promise.resolve(spaceUsage(stranger, s.id))).rejects.toMatchObject({ status: 404 });
});
```

Add a `seedItem` helper alongside the existing helpers if one does not exist. Wrap thenables in `Promise.resolve(...)` before `.rejects` — Bun 1.3.14 hangs on a raw `sql` thenable.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && bun test test/spaces.test.ts`
Expected: FAIL — `spaceUsage` is not defined.

- [ ] **Step 3: Implement**

In `apps/api/src/spaces.ts`:

```ts
/** Live sum; no stored counter to drift. Folders have a NULL size and
 *  contribute nothing, so no kind filter is needed. */
export async function spaceUsage(user: User, spaceId: string) {
  await requireSpace(user.id, spaceId, VIEWER);
  const [row] = await sql`
    SELECT COALESCE(SUM(size), 0)::bigint AS bytes, COUNT(*)::int AS items
      FROM items
     WHERE space_id = ${spaceId}
       AND status = 'ready'
       AND deleted_at IS NULL
       AND size IS NOT NULL`;
  return { bytes: Number(row.bytes), items: row.items };
}
```

In `apps/api/src/server.ts`, beside the other `/api/spaces/:id/*` routes:

```ts
"/api/spaces/:id/usage": {
  GET: route(async (req) => json(await spaceUsage(await requireUser(req), req.params.id))),
},
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && bun test test/spaces.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation check**

Delete `AND space_id = ${spaceId}` and confirm the named sum test fails. Delete the `requireSpace` line and confirm the non-member test fails. Restore both.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/spaces.ts apps/api/src/server.ts apps/api/test/spaces.test.ts
git commit -m "feat(api): live space usage endpoint"
```

---

### Task 2: Backend — add space member by email

**Files:**
- Modify: `apps/api/src/spaces.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/test/spaces.test.ts`

**Interfaces:**
- Produces: `POST /api/spaces/:id/members` accepts **either** `{subject, role}` (unchanged) **or** `{email, role}`.

**Why:** the only user directory is `GET /api/admin/users`, which is admin-gated. Without this, a non-admin OWNER cannot discover a user id and membership is silently admin-only. See spec R2.

- [ ] **Step 1: Write the failing tests**

```ts
test("adds a member by email, normalizing case and whitespace", async () => {
  const owner = await makeUser();
  const invitee = await makeUser({ email: "person@example.com" });
  const s = await createSpace(owner, "S");

  await addSpaceMemberByEmail(owner, s.id, "  PERSON@Example.com  ", EDITOR);

  const members = await listSpaceMembers(owner, s.id);
  expect(members.find((m) => m.subject_id === invitee.id)?.role).toBe(EDITOR);
});

test("an unknown email is 404", async () => {
  const owner = await makeUser();
  const s = await createSpace(owner, "S");
  await expect(Promise.resolve(addSpaceMemberByEmail(owner, s.id, "nobody@example.com", VIEWER)))
    .rejects.toMatchObject({ status: 404 });
});

test("a non-owner cannot add by email", async () => {
  const owner = await makeUser();
  const viewer = await makeUser();
  const target = await makeUser({ email: "t@example.com" });
  const s = await createSpace(owner, "S");
  await addSpaceMember(owner, s.id, { type: "user", id: viewer.id }, VIEWER);
  await expect(Promise.resolve(addSpaceMemberByEmail(viewer, s.id, "t@example.com", VIEWER)))
    .rejects.toMatchObject({ status: 403 });
});
```

Also add a route-level test asserting that a body with **both** `subject` and `email`, and one with **neither**, each return 400.

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && bun test test/spaces.test.ts`
Expected: FAIL — `addSpaceMemberByEmail` is not defined.

- [ ] **Step 3: Implement**

In `apps/api/src/spaces.ts`:

```ts
/** Resolve an email to a user, then reuse the id path. Normalization must
 *  match register() exactly or an invite silently fails to find the account. */
export async function addSpaceMemberByEmail(
  user: User, spaceId: string, email: string, role: number,
) {
  const normalized = String(email ?? "").trim().toLowerCase();
  if (!normalized) throw new HttpError(400, "email is required");
  const [target] = await sql`SELECT id FROM users WHERE email = ${normalized}`;
  if (!target) throw new HttpError(404, "no user with that email");
  await addSpaceMember(user, spaceId, { type: "user", id: target.id }, role);
}
```

The `requireSpace(OWNER)` check inside `addSpaceMember` still runs, so the
authorization order is unchanged — but note the lookup happens **before** it,
so a non-owner probing emails learns nothing beyond the eventual 403.

In `apps/api/src/server.ts`, widen the members POST:

```ts
POST: route(async (req) => {
  const u = await requireUser(req);
  const b = await body<{ subject?: Subject; email?: string; role: string }>(req);
  if ((b.subject && b.email) || (!b.subject && !b.email)) {
    throw new HttpError(400, "provide exactly one of subject or email");
  }
  if (b.email) await addSpaceMemberByEmail(u, req.params.id, b.email, parseRole(b.role));
  else await addSpaceMember(u, req.params.id, b.subject!, parseRole(b.role));
  return json({ ok: true });
}),
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && bun test`
Expected: PASS, and every pre-existing test still green (the `{subject}` form must be unchanged).

- [ ] **Step 5: Mutation check**

Remove `.toLowerCase()` and confirm the normalization test fails. Remove the both/neither guard and confirm the 400 route test fails. Restore.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/spaces.ts apps/api/src/server.ts apps/api/test/spaces.test.ts
git commit -m "feat(api): add space members by email"
```

---

### Task 3: Admin creates users

**Files:**
- Modify: `apps/web/src/api/queries.ts`
- Modify: `apps/web/src/routes/admin/Users.tsx`
- Test: `apps/web/test/admin.test.tsx`

**Interfaces:**
- Consumes: `POST /api/auth/register` `{email, password, name}`; `PATCH /api/admin/users/:id` `{is_admin}`.
- Produces: `useCreateUser()`.

**Server rules to mirror client-side** (from `register()`): password ≥ 8 characters, email matching `/^[^@\s]+@[^@\s]+\.[^@\s]+$/`, name non-empty after trim. A duplicate email returns **409**.

- [ ] **Step 1: Write the failing tests**

```tsx
test("creating a user posts register, then only PATCHes admin when checked", async () => { /* … */ });
test("a duplicate email shows the actionable conflict message, not a generic error", async () => { /* … */ });
test("the generated password is shown once and never reaches storage or the console", async () => { /* … */ });
test("a 500 from the users list renders an error with Retry, never 'no users yet'", async () => { /* … */ });
```

For the 409 test, make the **mocked** server body opaque (e.g. `{"error":"conflict"}`) so the assertion proves the UI does the mapping rather than echoing the mock. This exact trap produced a false-negative test in the previous cycle.

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/web && npm test -- admin`

- [ ] **Step 3: Append the hook**

```ts
export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { name: string; email: string; password: string; isAdmin: boolean }) => {
      const user = await api.post<User>("/api/auth/register", {
        email: v.email, password: v.password, name: v.name,
      });
      // register() takes no admin flag; promotion is a second, separate call.
      if (v.isAdmin) await api.patch(`/api/admin/users/${user.id}`, { is_admin: true });
      return user;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["adminUsers"] }); },
  });
}
```

- [ ] **Step 4: Build the form in `Users.tsx`**

Name, email, password, and an "Administrator" checkbox. Validate client-side against the three server rules above. Map `isConflict(error)` to a message naming the duplicate email. On success, render the password once with a note that it cannot be recovered and must be given to the person directly.

- [ ] **Step 5: Run to verify they pass**

Run: `cd apps/web && npm test && npm run typecheck`

- [ ] **Step 6: Mutation check**

Make the 409 render a generic error and confirm the named conflict test fails. Remove the `isAdmin` guard so it always PATCHes, and confirm the first test fails. Restore both.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/api/queries.ts apps/web/src/routes/admin/Users.tsx apps/web/test/admin.test.tsx
git commit -m "feat(web): admin creates users"
```

---

### Task 4: Create a space, and fix the dead end

**Files:**
- Modify: `apps/web/src/api/queries.ts`
- Create: `apps/web/src/components/CreateSpaceModal.tsx`
- Modify: `apps/web/src/routes/SpaceRedirect.tsx`, `apps/web/src/components/Sidebar.tsx`
- Test: `apps/web/test/spaces.test.tsx`

**Interfaces:**
- Consumes: `POST /api/spaces` `{name}` → `{id, name, created_at}`. The creator becomes OWNER in the same transaction.
- Produces: `useCreateSpace()`, `<CreateSpaceModal>`.

**This task closes the live dead end.** `SpaceRedirect` currently renders "You are not a member of any space yet" with no affordance, which is where a newly created user lands.

- [ ] **Step 1: Write the failing tests**

```tsx
test("the empty state offers to create a space, and creating one navigates to it", async () => { /* … */ });
test("a 500 while loading spaces shows an error with Retry, not the empty state", async () => { /* … */ });
test("creating a space invalidates the spaces list", async () => { /* … */ });
```

The second test is the `isPending`/`isError` guard for this screen specifically — it has already been the source of one defect here.

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/web && npm test -- spaces`

- [ ] **Step 3: Append the hook**

```ts
export function useCreateSpace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.post<Space>("/api/spaces", { name }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["spaces"] }); },
  });
}
```

- [ ] **Step 4: Build `CreateSpaceModal` and wire both entry points**

Reuse the existing `Modal` (Escape to close, backdrop click). One trimmed, non-empty name field. Mount it from the sidebar space switcher's "New space" action and from `SpaceRedirect`'s empty state as the primary button. Conditionally render so it unmounts on close. On success, navigate to `/s/:newId`.

- [ ] **Step 5: Run to verify they pass**

Run: `cd apps/web && npm test && npm run typecheck`

- [ ] **Step 6: Mutation check**

Remove the `isError` branch from `SpaceRedirect` and confirm the named 500 test fails. Restore.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): create spaces and fix the no-space dead end"
```

---

### Task 5: Space membership screen

**Files:**
- Modify: `apps/web/src/api/queries.ts`
- Create: `apps/web/src/routes/SpaceMembers.tsx`
- Modify: `apps/web/src/App.tsx`, `apps/web/src/components/Sidebar.tsx`
- Test: `apps/web/test/members.test.tsx`

**Interfaces:**
- Consumes: `GET /api/spaces/:id/members` → `{subject_type, subject_id, role, name, email}[]`; `POST` with `{email, role}` or `{subject, role}`; `DELETE` with `{subject}`.
- Produces: `useAddSpaceMember`, `useUpdateSpaceMemberRole`, `useRemoveSpaceMember`; route `/space/:spaceId/members`.

- [ ] **Step 1: Write the failing tests**

```tsx
test("lists users and groups distinguishably", async () => { /* … */ });
test("adding by email sends {email, role} and refreshes the list", async () => { /* … */ });
test("an unknown email surfaces the 404 as 'no user with that email'", async () => { /* … */ });
test("a non-owner sees an ownership-required state, not a broken screen", async () => { /* … */ });
test("removing your own owner role warns before proceeding", async () => { /* … */ });
test("a 500 renders an error with Retry, never an empty member list", async () => { /* … */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/web && npm test -- members`

- [ ] **Step 3: Append the hooks**

Each mutation invalidates `["spaceMembers", spaceId]`. Roles travel as wire strings.

- [ ] **Step 4: Build the screen and route it**

Add `/space/:spaceId/members` inside the authenticated `AppShell` block — **not** as a sibling of `/share/:token`. Reachable from a space menu in the sidebar. Groups are visually marked as groups, because granting to an empty group does nothing. Removing your own OWNER role requires an explicit confirmation naming the consequence: you lose access to the space.

- [ ] **Step 5: Run to verify they pass**

Run: `cd apps/web && npm test && npm run typecheck`

- [ ] **Step 6: Mutation check**

Make the 404 render a generic error and confirm the named unknown-email test fails. Remove the self-demotion warning and confirm its test fails. Restore both.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src apps/web/test
git commit -m "feat(web): space membership management"
```

---

### Task 6: Group membership and the storage meter

**Files:**
- Modify: `apps/web/src/api/queries.ts`, `apps/web/src/routes/admin/Groups.tsx`
- Create: `apps/web/src/components/StorageMeter.tsx`
- Modify: `apps/web/src/components/Sidebar.tsx`
- Test: `apps/web/test/admin.test.tsx`, `apps/web/test/shell.test.tsx`

**Interfaces:**
- Consumes: `GET|POST|DELETE /api/groups/:id/members` (`{user_id}`, admin-only); `GET /api/spaces/:id/usage` from Task 1.
- Produces: `useGroupMembers`, `useAddGroupMember`, `useRemoveGroupMember`, `useSpaceUsage`, `<StorageMeter>`.

Two small pieces share one task because neither justifies its own review cycle.

- [ ] **Step 1: Write the failing tests**

```tsx
test("expanding a group lists its members", async () => { /* … */ });
test("adding a member updates member_count without a manual refresh", async () => { /* … */ });
test("the meter shows bytes used with no bar and no percentage", async () => { /* … */ });
test("a 500 from usage hides the meter rather than showing 0 B", async () => { /* … */ });
```

The last two matter: there is **no quota**, so any bar or percentage would imply a ceiling that does not exist, and showing "0 B" on a failed request is a lie about the user's data.

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/web && npm test`

- [ ] **Step 3: Append the hooks**

`useAddGroupMember`/`useRemoveGroupMember` invalidate both `["groupMembers", groupId]` and `["groups"]` so `member_count` refreshes.

- [ ] **Step 4: Build both pieces**

Members are chosen from `GET /api/admin/users`. `StorageMeter` renders `formatBytes(bytes)` as plain text and renders nothing at all on error.

- [ ] **Step 5: Run to verify they pass**

Run: `cd apps/web && npm test && npm run typecheck && npm run build`

- [ ] **Step 6: Mutation check**

Drop `["groups"]` from the add-member invalidation and confirm the `member_count` test fails. Restore.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src apps/web/test
git commit -m "feat(web): group membership and storage meter"
```

---

### Task 7: End-to-end — onboard a second human

**Files:**
- Modify: `apps/web/e2e/flows.spec.ts`, `apps/web/e2e/fixtures.ts`

**This is the point of the cycle.** Every other task is unproven until a second person can actually sign in and see a space.

**Environment** (same as the previous cycle): Postgres and MinIO on loopback via `docker compose`; the dev API on `:3011`; admin `admin@hdrive.local` / `hunter2hunter2`. **Do not run `bun test` in `apps/api`** — it TRUNCATEs the database and destroys the fixtures.

- [ ] **Step 1: Write the flow**

```ts
test("an admin onboards a second user end to end", async ({ page, browser }) => {
  // 1. Admin signs in, creates a user with a known password.
  // 2. Admin creates a space.
  // 3. Admin adds the new user to it BY EMAIL as an editor.
  // 4. A FRESH browser context signs in as that user.
  // 5. That user sees the space — no "not a member of any space" dead end.
});
```

Step 4 must use `browser.newContext()`, not the same page — reusing the session proves nothing about a second person.

- [ ] **Step 2: Run it**

Run: `cd apps/web && npm run e2e`
Expected: this flow passes alongside the existing five.

- [ ] **Step 3: Verify it fails when the feature breaks**

Temporarily make the members POST send a bogus email; confirm the flow fails at the sign-in step rather than passing silently. Restore.

- [ ] **Step 4: Full suite**

Run: `cd apps/web && npm test && npm run typecheck && npm run build && npm run e2e`

- [ ] **Step 5: Commit**

```bash
git add apps/web/e2e
git commit -m "test(web): end-to-end second-user onboarding"
```

---

## Deployment note (after the final review, not per-task)

The live site serves a static build from `/var/www/drive`. After this cycle
clears its final review, redeploy:

```bash
cd apps/web && npm run build
grep -c 'localhost:3011' dist/assets/*.js   # must be 0
sudo rsync -a --delete dist/ /var/www/drive/
```

The API runs under pm2 as `hdrive-api` against the `hdrive_prod` database.
Tasks 1 and 2 change the API, so it **does** need a restart this cycle:
`pm2 restart hdrive-api`.
