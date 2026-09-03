# Hdrive Frontend — Design

Date: 2026-09-03
Status: draft for review
Backend spec: `docs/superpowers/specs/2026-09-03-hdrive-design.md` (implemented, 151 tests)
Design source: `docs/references/hdrive.html` → extracted to `docs/references/design-extraction.md`

## 1. Scope

Build the screens the existing backend supports, in the visual language of the
design mockup.

**In scope:** sign-in, file browser (My files / Shared / Recent / Trash), video
player, upload, download, rename, move, trash + restore, share links, per-item
permissions (users and groups), space management, and the admin surface
(storage backends, users, groups).

**Explicitly out of scope**, both present in the mockup, neither supported by
the backend:

- **Packages** — file bundling with a request/approve flow. A whole subsystem:
  new tables, endpoints, approval state machine.
- **Chat / DMs**, plus the people directory and profile screens that serve it.

Each would need its own spec and backend work comparable in size to the backend
already built. They are omitted, not deferred inside this plan.

**Also out of scope:** search. The mockup's header search and file-list search
are placeholder inputs with no behaviour, and the backend has no search
endpoint. Consistent on both sides — leave it out rather than half-build it.

## 2. Decisions

| Decision | Choice | Why |
|---|---|---|
| Framework | Vite + React + TypeScript | As specified |
| Routing | React Router | The mockup is state-machine driven with no URLs. Deep links to folders, share links, and the back button all need real routes |
| Server state | TanStack Query | This app is almost entirely server state; hand-rolled cache invalidation across upload/move/trash is where the bugs would be |
| Styling | Plain CSS with custom properties | The mockup uses literal inline hex everywhere. Tokens become CSS variables; no CSS-in-JS runtime, no Tailwind (the mockup does not use it) |
| Auth | Email + password | The mockup shows Google-only sign-in, but the backend is email+password and registration is admin-only. Decided: keep the backend, restyle the form |
| Signup screen | Not built | Registration is admin-gated. Admins create users from the admin surface |
| Dark mode | Sidebar only | Matches the mockup, which defines no dark variant for header, content, or modals |
| Bulk actions | None | The mockup has no multi-select on file rows, and the backend has no bulk endpoints |

### Frontend dependencies

The `apps/api` zero-runtime-dependency rule does **not** extend to `apps/web`. A
router and a data layer are load-bearing; hand-rolling them is a false economy.
Dependencies stay few and boring: `react`, `react-dom`, `react-router-dom`,
`@tanstack/react-query`. Anything beyond that needs a reason.

## 3. The visibility model — a corrected mapping

This is the one place the mockup and the backend genuinely disagree, and the
resolution changes user-visible copy.

**The mockup's three tiers:**

| Badge | Mockup copy |
|---|---|
| Private (grey) | "Only you can open it" |
| Shared (indigo) | "Anyone in Northwind Studio" |
| Public (green) | "Anyone with the link, no sign-in" |

**The backend cannot express "Private".** Permissions are grant-only with no
deny rules — a decision made deliberately, because deny rules across an
inherited tree make "why can't I see this?" unanswerable. Every member of a
space sees everything in it by inheritance. An item that is private *within* a
shared space is not representable, and making it representable means adding
denies.

Three tiers remain distinguishable, but they are these:

| Badge | Colours (unchanged) | Computed from | Corrected copy |
|---|---|---|---|
| **Space** | grey `#5B6169` / bg `#EDEFF2` / dot `#8A9099` | No `item_grants`, no live share link | "Everyone in {space name}" |
| **Shared** | indigo `#3B3BE8` / bg `#EEEEFD` / dot `#3B3BE8` | Has one or more `item_grants` | "Space members, plus {n} more" |
| **Public** | green `#1F7A4C` / bg `#E8F5EE` / dot `#1F7A4C` | Has a live, unexpired, unrevoked share link | "Anyone with the link, no sign-in" |

**Public wins** when an item is both granted and shared by link: the badge
should show the broadest exposure, not the narrowest.

The mockup's All / Private / Shared / Public filter tabs survive with
Private → Space. The visual system — three colours, three dots, one badge
component — is unchanged; only the labels and the tooltip copy move.

**If per-item privacy is actually wanted**, that is a backend change (deny
rules, or per-item ACLs that override inheritance) and needs its own spec. It
should not be faked in the UI.

## 4. Screens

### From the mockup

- **Sign-in** — the mockup's split layout and brand panel, with email+password
  fields replacing the Google button. No signup link.
- **App shell** — sidebar (nav + storage meter) + header + content. Sidebar
  supports the mockup's light/dark variants.
- **File browser** — table with NAME / OWNER / VISIBILITY / SIZE / MODIFIED
  columns in IBM Plex Mono uppercase headers, visibility filter tabs, row
  hover actions, empty states.
- **Video player** — the mockup's dark player chrome. Seeking works through the
  backend's Range support with a plain `<video>` element.
- **Members & permissions** — per-user list from the mockup, extended with a
  groups tab.
- **Workspace switcher** — spaces.
- **Account settings**, **upload toast**, **share modal**.

### Designed here, in the mockup's established style

The mockup has no precedent for these. They use its existing tokens and
component vocabulary — same table, badge, modal, and button primitives.

- **Rename** — inline edit on the file row, not a modal. Escape cancels, Enter
  commits, 409 on a name collision shows inline.
- **Move** — folder-picker modal with a tree, disabled targets for the item's
  own subtree.
- **Group grants** — a second tab in the existing permissions modal, reusing the
  member-row component with a group avatar variant.
- **Share unlock** — a standalone public page for password-protected links. No
  app chrome, no sidebar: the viewer is not signed in.
- **Admin** — storage backends (list, add, edit, set write target, test
  connection with the probe's four-step result, delete), users (list, promote,
  demote), groups (list, create, membership). Reuses the file-browser table.

## 5. The hard parts

**Upload is a three-step handshake, not a POST.**
`POST /api/spaces/:id/uploads` reserves the row and returns a presigned URL →
browser `PUT`s directly to S3 → `POST /api/items/:id/complete` confirms. Real
progress comes from `XMLHttpRequest.upload` on the direct PUT (`fetch` has no
upload progress).

The mockup's upload toast shows progress only. It needs a third state:
**finishing** — between the bytes landing and the confirm returning. Without it
the bar sits at 100% while nothing appears to happen. The toast also needs a
failure state with retry, since the PUT can fail independently of the reserve.

**CORS does not exist yet, and there are two of them.**
The API sends no CORS headers, and the Vite dev server is a different origin —
so `apps/api` needs an OPTIONS handler and an allowlisted origin. Separately,
the direct-to-S3 PUT needs CORS configured *on the bucket*. The second is the
one most likely to bite on BiznetGeo, and it is the fallback trigger named in
the backend spec's risk list: if bucket CORS cannot be configured, uploads
proxy through the API and the `StorageBackend` interface absorbs it.

**Share unlock is two steps.** `POST /s/:token/unlock` verifies the password and
sets a short-lived path-scoped cookie; the subsequent `GET /s/:token` streams.
The unlock page must not leak which failure occurred — the backend returns a
uniform 404 for unknown/expired/revoked and 401 only for a bad password, and the
UI must not add distinctions the API deliberately removed.

**Permission-gated UI.** The API returns 403 or 404 by role, but the UI should
not offer actions that will fail. Effective role per item drives which row
actions render. A 404 for a no-access item is deliberate on the backend — the UI
must treat it as "not found", not "forbidden", or it leaks the same existence
the backend hides.

## 6. API client

A single typed client module wrapping `fetch`, with hand-written types in
`src/api.d.ts` (no codegen pipeline for this surface size). It owns:

- session handling (cookie-based; the backend sets `hd_session` HttpOnly)
- a 401 interceptor that routes to sign-in
- error normalisation — the API returns `{error: string}` with meaningful
  statuses; the client turns those into typed errors the UI can branch on
- the upload handshake as one function with a progress callback, so no component
  reimplements the three steps

## 7. Testing

- **Vitest + React Testing Library** for logic: the upload state machine
  (including the finishing and failure states), the visibility computation
  (all three tiers plus the Public-wins rule), permission-gated rendering, and
  error normalisation.
- **Playwright** for the flows that span the handshake and cannot be verified in
  isolation: upload end to end, share-link create → unlock → stream, video seek
  issuing a Range request, and trash → restore.

Given how the backend went — where the recurring defect was tests that passed
while the property they named was broken — a few real end-to-end tests are worth
more than many shallow component tests. Every test must be able to fail: assert
observable behaviour, not that a component rendered.

## 8. Risks

- **Bucket CORS on BiznetGeo.** Fallback is proxied uploads; the interface
  absorbs it, but it changes the upload path's performance story.
- **Fonts.** The mockup uses self-hosted Bricolage Grotesque and IBM Plex Mono
  via `@font-face`. They must be vendored, with a real fallback stack.
- **The corrected visibility copy** changes user-visible strings from the
  mockup. If "Private" must mean "only you", that is a backend change and this
  spec is wrong about scope.
