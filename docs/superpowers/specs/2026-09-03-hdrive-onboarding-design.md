# Hdrive Onboarding Cycle — Design

**Status:** approved
**Date:** 2026-09-03
**Parent spec:** `docs/superpowers/specs/2026-09-03-hdrive-frontend-design.md`
**Depends on:** `feat/backend`, `feat/frontend` (both complete and deployed)

## 1. Why this exists

Hdrive is deployed at https://drive.mhamzah.id and works for exactly one
person. The parent spec said "Admins create users from the admin surface,"
but the implementation plan never turned that sentence into a task, so the
API endpoints exist with no callers:

| Capability | Endpoint | Frontend caller |
|---|---|---|
| Create a user | `POST /api/auth/register` (admin-gated) | none |
| Create a space | `POST /api/spaces` | none |
| Add/remove space member | `POST`/`DELETE /api/spaces/:id/members` | none |
| Add/remove group member | `POST`/`DELETE /api/groups/:id/members` | none |

The user-visible consequence: a person who signs in with no space membership
lands on `SpaceRedirect`'s "You are not a member of any space yet" — a
terminal state with no affordance. Group grants are also inert, because a
group can be created but never populated.

This cycle closes the onboarding path and nothing else.

## 2. Scope

**In scope**

1. Admin creates users.
2. Any authenticated user creates a space (and becomes its OWNER).
3. Space membership: list, add, change role, remove.
4. Group membership: list, add, remove.
5. Sidebar storage meter.
6. End-to-end proof that a second human can be onboarded.

**Out of scope** — still open after this cycle, tracked for a later plan:
the header component, visibility filter tabs, functional Shared/Recent nav,
role-gated row actions, and the tree move-picker. These are cosmetic or
convenience gaps; none of them blocks a second user.

## 3. Rulings

Two decisions were made during design rather than deferred. Both are
recorded here because a future reader will otherwise assume they were
oversights.

### R1 — Admins get no automatic access to spaces they do not belong to

`addSpaceMember` and `removeSpaceMember` call
`requireSpace(user.id, spaceId, OWNER)`, which has no admin bypass. An
administrator who is not a member of a space therefore cannot manage its
membership.

**This stays as it is.** For a shared team drive, an admin silently holding
read/write access to every team's private space is a worse property than an
admin occasionally having to ask for access. Admins can always create their
own spaces (becoming OWNER), and can be added to others like anyone else.

Consequence for the UI: the membership screen must handle a 403/404 for a
space the current user does not own, rather than assuming admin omnipotence.

### R2 — Space members are added by email address, not user id

The only user directory in the system is `GET /api/admin/users`, which is
admin-gated. A non-admin space OWNER has no way to discover the id of the
person they want to add, so membership management would be admin-only in
practice while appearing to be owner-available.

**`POST /api/spaces/:id/members` gains an email form.** The caller sends an
email address; the backend resolves it to a user id. This is the pattern
team tools use, and it avoids exposing a browsable directory of every
account to every user.

Accepted tradeoff: a space owner can probe whether a given email has an
account, because "no such user" must be distinguishable from success for
the feature to be usable. In a system where registration is admin-only and
the user population is a known team, this is acceptable. It is noted here
so nobody later mistakes it for an oversight.

## 4. API changes

Two additions. Everything else this cycle needs already exists.

### 4.1 `GET /api/spaces/:id/usage`

Authorization: `requireSpace(user.id, spaceId, VIEWER)` — any member.

Response: `{ "bytes": 1234567, "items": 42 }`

Computed live from the `items` table: sum of `size` over rows in the space
that are `status = 'ready'` and not soft-deleted. No schema change, no
stored counter to drift out of sync.

There is no quota. The meter reports usage against no limit, because the
system enforces none. The UI must not imply a ceiling that does not exist.

### 4.2 `POST /api/spaces/:id/members` accepts an email subject

Existing body, unchanged and still supported:

```json
{ "subject": { "type": "user" | "group", "id": "<uuid>" }, "role": "viewer" | "editor" | "owner" }
```

New alternative form:

```json
{ "email": "person@example.com", "role": "viewer" | "editor" | "owner" }
```

The backend resolves the email (normalized: trimmed, lowercased, matching
`register`'s normalization) to a user id and proceeds exactly as before.
Unknown email returns **404 `{"error":"no user with that email"}`**.
Supplying both `subject` and `email`, or neither, returns 400.

Authorization is unchanged: OWNER on the space.

## 5. Screens

### 5.1 Admin creates a user — `/admin/users`

The existing users list gains a create form: **name**, **email**,
**password**, **admin** checkbox.

- `POST /api/auth/register` with `{email, password, name}`, then
  `PATCH /api/admin/users/:id` with `{is_admin: true}` only if the box is
  checked. Registration does not accept an admin flag.
- Client-side validation mirrors the server exactly so the common errors do
  not require a round trip: password minimum 8 characters, email matching
  `/^[^@\s]+@[^@\s]+\.[^@\s]+$/`, name non-empty after trimming.
- A duplicate email returns 409 and must surface as a specific, actionable
  message naming the conflict — not a generic failure.
- On success the new user appears in the list without a manual refresh.
- The password is displayed once, in the success state, with an explicit
  note that it is not recoverable and must be handed to the person
  out-of-band. It is never written to storage, a log, or a URL.

### 5.2 Create a space

Two entry points, one component:

- **Sidebar space switcher** gains a "New space" action.
- **`SpaceRedirect`'s empty state** — today a dead end — gains a primary
  "Create a space" button. This is the fix that makes a fresh account
  usable.

`POST /api/spaces` with `{name}`. The creator becomes OWNER automatically
(the backend does this in the same transaction). On success, navigate to
the new space.

### 5.3 Space members — `/s/:spaceId/members`

Reached from a space menu in the sidebar. Lists current members from
`GET /api/spaces/:id/members`, which returns `subject_type`, `subject_id`,
`role`, `name`, and `email`.

- Users and groups are visually distinguishable; a group row shows it is a
  group, since granting to an empty group does nothing.
- **Add a user** by email (R2), with a role select defaulting to VIEWER.
- **Add a group** by picking from `GET /api/groups` (admin-only endpoint —
  offer this control only when the current user is an admin).
- **Change a role** in place; **remove** a member with confirmation.
- Roles display as Viewer / Editor / Owner and travel on the wire as
  `"viewer"`, `"editor"`, `"owner"`.
- A non-owner reaching this route sees a clear "you need to be an owner of
  this space" state rather than a broken screen (see R1).
- **Removing your own OWNER role locks you out of the space.** Warn
  explicitly before allowing it.

### 5.4 Group membership — `/admin/groups`

The existing groups list gains per-group membership management:
`GET /api/groups/:id/members` to list, `POST` with `{user_id}` to add,
`DELETE` with `{user_id}` to remove. All three are admin-only.

Members are chosen from `GET /api/admin/users`, which the admin can already
reach. `member_count` on the row must reflect changes without a manual
refresh.

### 5.5 Storage meter

In the sidebar, showing bytes used for the current space, formatted with
the existing `formatBytes`. No progress bar and no percentage — there is no
quota to be a percentage of. A plain "1.4 GB used" is honest; a bar implying
a ceiling is not.

## 6. Permission model

Unchanged from the parent spec. Restated because these screens are where it
becomes visible:

- Roles are `VIEWER=1 < EDITOR=2 < OWNER=3`; effective role is the maximum
  across the user's own membership and their groups' memberships.
- Space membership grants a floor for everything in the space; per-item
  grants can raise it and never lower it.
- No access is **404, never 403** — the UI must never render "forbidden"
  for a resource the API is hiding. The admin routes are the deliberate
  exception: they 403, because the sidebar already reveals they exist.

## 7. Testing

Same standards as the parent cycle; these are the properties that must have
a named test that genuinely fails when the property breaks.

**Backend**
- Usage sums only ready, non-deleted items in the requested space, and a
  non-member gets 404.
- Add-by-email resolves a normalized address; unknown email is 404; both or
  neither of `subject`/`email` is 400; a non-OWNER is refused.

**Frontend**
- Every list branches on `isError` explicitly before any empty check. React
  Query v5 settles `isPending` to false on error too, so
  `if (isPending) … if (!data?.length)` reports a server fault as an empty
  result. This pattern caused four defects in the previous cycle.
- The duplicate-email 409 renders its specific message, and the assertion
  must not pass merely because the mocked server body already contains the
  expected wording — the test must prove the UI does the mapping.
- The created password appears exactly once and never enters
  `localStorage`, `sessionStorage`, a URL, or the console.
- Mutations invalidate query keys that actually match the lists they
  change: creating a user refreshes `["adminUsers"]`, creating a space
  refreshes `["spaces"]`, membership changes refresh the member list and
  `member_count`.

**End-to-end** — one flow, and it is the point of the whole cycle: an admin
creates a user, creates a space, adds that user by email, and then a
**second browser context signs in as that user and sees the space**. This
is the only test that proves the dead end is actually gone.

## 8. Non-goals

No email delivery, no invitation tokens, no forced password rotation, no
quotas, no per-space storage backends, no self-service signup. Each was
considered and rejected as larger than the problem this cycle solves.
