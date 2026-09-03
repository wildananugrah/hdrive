# Hdrive Frontend Implementation Plan — Part 1 (Tasks 1–6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working Hdrive web client — sign in, browse, upload, stream, share, and administer — matching the design mockup's visual language.

**Architecture:** Vite + React + TypeScript. React Router for real URLs (the mockup is state-machine driven with none). TanStack Query owns all server state. Design tokens become CSS custom properties; the mockup uses literal inline hex everywhere.

**Tech Stack:** Vite, React 18, TypeScript, react-router-dom, @tanstack/react-query, Vitest + React Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-03-hdrive-frontend-design.md`
**Design reference:** `docs/references/design-extraction.md` (extracted from `docs/references/hdrive.html`)

**Continues in:** `docs/superpowers/plans/2026-09-03-hdrive-frontend-part2.md` (Tasks 7–12)

---

## Global Constraints

- **Node 20.20.2, Bun 1.3.14, npm 10.8.2** — all present. `apps/web` uses npm; `apps/api` stays on Bun.
- **`apps/api` keeps its zero-runtime-dependency rule.** Task 1 touches the API and must not add packages.
- **`apps/web` dependencies stay few and boring:** `react`, `react-dom`, `react-router-dom`, `@tanstack/react-query`. Dev: `vite`, `@vitejs/plugin-react`, `typescript`, `vitest`, `@testing-library/react`, `@testing-library/user-event`, `jsdom`, `@playwright/test`. Anything else needs a stated reason.
- **Ports:** API `3011`, Vite dev `5183` (5173 may collide; 3000/3001/8080/9090 are occupied on this machine).
- **Never invent copy.** Use the strings in `design-extraction.md` §6 verbatim where they exist.
- **Visibility badge copy is CORRECTED from the mockup** (spec §3): grey badge is **Space** — "Everyone in {space}", not "Private — only you". The backend is grant-only and cannot express per-item privacy.
- **No access is 404, not 403.** The UI must render a not-found state, never "forbidden" — a 403 would leak existence the API deliberately hides.
- **Never trust the client for file metadata.** Size and mime come from the API; do not display values the browser guessed.

---

## Verified Environment Facts

Checked against the real repo before this plan was written. Do not "fix" these.

**1. The mockup's fonts are NOT in the file.** All 22 `@font-face` rules reference design-tool asset ids (`src: url("821472be-c980-40a7-8702-18a46e9bea0e") format('woff2')`) with zero base64 payloads. Bricolage Grotesque and IBM Plex Mono are both open-source; self-host them from Google Fonts. The mockup cannot supply them.

**2. The API has 28 routes.** Full surface, verified from `apps/api/src/server.ts`:

```
GET    /api/health
POST   /api/auth/register          (requireAdmin)
POST   /api/auth/login
POST   /api/auth/logout
GET    /api/auth/me
GET    /api/spaces                 POST /api/spaces
POST   /api/spaces/:id/members     DELETE /api/spaces/:id/members
POST   /api/groups                                        (requireAdmin)
POST   /api/groups/:id/members    DELETE /api/groups/:id/members  (requireAdmin)
GET    /api/spaces/:id/children    ?parent=<uuid|omitted>
POST   /api/spaces/:id/folders
GET    /api/items/:id              PATCH /api/items/:id      DELETE /api/items/:id
POST   /api/items/:id/restore
GET    /api/spaces/:id/trash
GET    /api/items/:id/grants       POST /api/items/:id/grants  DELETE /api/items/:id/grants
POST   /api/spaces/:id/uploads
POST   /api/items/:id/complete
GET    /api/items/:id/content      ?inline=1, honours Range
GET    /api/admin/users            PATCH /api/admin/users/:id     (requireAdmin)
GET    /api/admin/backends         POST /api/admin/backends       (requireAdmin)
PATCH  /api/admin/backends/:id     DELETE /api/admin/backends/:id (requireAdmin)
POST   /api/admin/backends/:id/write-target                       (requireAdmin)
POST   /api/admin/backends/:id/probe                              (requireAdmin)
GET    /api/items/:id/shares       POST /api/items/:id/shares
DELETE /api/shares/:id
POST   /s/:token/unlock            GET /s/:token        (public, no session)
```

**3. Three list endpoints are MISSING and block design screens** — Task 1 adds them:
`GET /api/groups`, `GET /api/spaces/:id/members`, `GET /api/groups/:id/members`. The API can create and delete these but never list them.

**4. No CORS handling exists** in `apps/api`. Vite dev is a different origin. Task 1 adds it.

**5. Auth is cookie-based.** `POST /api/auth/login` sets `hd_session` (HttpOnly, SameSite=Lax, Path=/) *and* returns `{user, token}`. Use the cookie — send `credentials: "include"` on every request — and ignore the token field in the browser.

**6. Registration is admin-only.** There is no public signup. Do not build a signup screen.

**7. `PATCH /api/items/:id` does both rename and move** in one transactional call: `{name?}`, `{parent_id?}`, or both. There is no separate move endpoint.

**8. Share unlock is two steps.** `POST /s/:token/unlock` with `{password}` sets a short-lived path-scoped cookie; then `GET /s/:token` streams. Unknown/expired/revoked all return an identical `404 {"error":"link not found or expired"}`; only a bad password is 401. The UI must not add distinctions the API removed.

---

## File Structure

```
apps/web/
  index.html
  package.json  vite.config.ts  tsconfig.json
  public/fonts/                      self-hosted woff2
  src/
    main.tsx                         entry, router, QueryClient
    styles/
      tokens.css                     design tokens as CSS custom properties
      base.css                       reset, fonts, global element styles
    api/
      types.ts                       hand-written API types
      client.ts                      fetch wrapper, error normalisation
      errors.ts                      ApiError + typed helpers
      upload.ts                      3-step handshake with progress
      queries.ts                     TanStack Query hooks
    lib/
      visibility.ts                  Space | Shared | Public computation
      format.ts                      bytes, dates
    components/                      Button, Badge, Modal, Table, Toast, Avatar…
    routes/
      SignIn.tsx  AppShell.tsx  Files.tsx  Trash.tsx  Video.tsx
      Permissions.tsx  Spaces.tsx  Settings.tsx
      admin/Backends.tsx  admin/Users.tsx  admin/Groups.tsx
      share/Unlock.tsx  share/View.tsx
  test/                              Vitest unit/component
  e2e/                               Playwright
```

---

## Task Ordering

| Task | Deliverable |
|---|---|
| 1 | **Backend prerequisites**: CORS + 3 missing list endpoints |
| 2 | Vite scaffold, fonts, design tokens, base styles |
| 3 | API client, types, error normalisation |
| 4 | Auth: sign-in screen, session, protected routes |
| 5 | App shell: sidebar, header, routing |
| 6 | File browser: table, visibility badges, filters, empty states |
| 7–12 | See Part 2 |

Task 1 is in `apps/api` and gates every later task that lists members or groups.

---

### Task 1: Backend prerequisites — CORS and the missing list endpoints

**Files:**
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/spaces.ts`
- Test: `apps/api/test/perm.test.ts` (append)

**Interfaces:**
- Consumes: `sql` from `db.ts`; `requireUser`, `requireAdmin` from `auth.ts`; `requireSpace`, `VIEWER` from `perm.ts`; `requireAdminUser` from `spaces.ts`.
- Produces:
  - `listGroups(user: User): Promise<{id, name, created_at, member_count}[]>`
  - `listGroupMembers(user: User, groupId: string): Promise<{id, email, name}[]>`
  - `listSpaceMembers(user: User, spaceId: string): Promise<{subject_type, subject_id, role, name, email}[]>`
  - `withCors(res: Response, origin: string | null): Response`
  - Routes: `GET /api/groups`, `GET /api/groups/:id/members`, `GET /api/spaces/:id/members`, plus `OPTIONS` preflight on all `/api/*`.

**Constraint:** `apps/api` must gain **no new dependencies**.

- [ ] **Step 1: Write the failing test** — append to `apps/api/test/perm.test.ts`

```ts
import { listGroupMembers, listGroups, listSpaceMembers } from "../src/spaces.ts";

test("listGroups returns groups with member counts, admin only", async () => {
  const admin = await makeUser({ admin: true });
  const plain = await makeUser();
  const g = await createGroup(admin as any, "eng");
  await addGroupMember(admin as any, g.id, plain.id);

  const rows = await listGroups(admin as any);
  const eng = rows.find((r: any) => r.id === g.id);
  expect(eng.name).toBe("eng");
  expect(eng.member_count).toBe(1);

  await expect(listGroups(plain as any)).rejects.toMatchObject({ status: 403 });
});

test("listGroupMembers returns members without password hashes", async () => {
  const admin = await makeUser({ admin: true });
  const member = await makeUser();
  const g = await createGroup(admin as any, "eng");
  await addGroupMember(admin as any, g.id, member.id);

  const rows = await listGroupMembers(admin as any, g.id);
  expect(rows.map((r: any) => r.id)).toEqual([member.id]);
  expect(JSON.stringify(rows)).not.toContain("password_hash");
  expect(JSON.stringify(rows)).not.toContain("$argon2");
});

test("listSpaceMembers resolves user and group subjects, requires space access", async () => {
  const owner = await makeUser();
  const other = await makeUser();
  const space = await createSpace(owner as any, "S");
  await addSpaceMember(owner as any, space.id, { type: "user", id: other.id }, VIEWER);

  const rows = await listSpaceMembers(owner as any, space.id);
  const mine = rows.find((r: any) => r.subject_id === other.id);
  expect(mine.role).toBe(VIEWER);
  expect(mine.email).toBe(other.email);

  const stranger = await makeUser();
  await expect(listSpaceMembers(stranger as any, space.id)).rejects.toMatchObject({ status: 404 });
});

test("listSpaceMembers never leaks password hashes", async () => {
  const owner = await makeUser();
  const space = await createSpace(owner as any, "S");
  const rows = await listSpaceMembers(owner as any, space.id);
  expect(JSON.stringify(rows)).not.toContain("password_hash");
  expect(JSON.stringify(rows)).not.toContain("$argon2");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && bun test test/perm.test.ts`
Expected: FAIL — `listGroups` is not exported from `spaces.ts`.

- [ ] **Step 3: Add the three list functions to `apps/api/src/spaces.ts`**

```ts
/** Groups are org-wide, so listing them is admin-only, matching the mutators. */
export async function listGroups(user: User) {
  requireAdminUser(user);
  return await sql`
    SELECT g.id, g.name, g.created_at,
           (SELECT count(*)::int FROM group_members m WHERE m.group_id = g.id) AS member_count
      FROM groups g ORDER BY lower(g.name)`;
}

export async function listGroupMembers(user: User, groupId: string) {
  requireAdminUser(user);
  checkUuid(groupId, "group id");
  return await sql`
    SELECT u.id, u.email, u.name
      FROM group_members m JOIN users u ON u.id = m.user_id
     WHERE m.group_id = ${groupId}
     ORDER BY lower(u.name)`;
}

/**
 * Members of a space, with each subject resolved to a display name.
 * Requires VIEWER on the space: anyone who can see the space can see who is in
 * it, but a non-member gets the same 404 as a non-existent space.
 */
export async function listSpaceMembers(user: User, spaceId: string) {
  checkUuid(spaceId, "space id");
  await requireSpace(user.id, spaceId, VIEWER);
  return await sql`
    SELECT m.subject_type, m.subject_id, m.role,
           COALESCE(u.name, g.name) AS name,
           u.email AS email
      FROM space_members m
      LEFT JOIN users  u ON m.subject_type = 'user'  AND u.id = m.subject_id
      LEFT JOIN groups g ON m.subject_type = 'group' AND g.id = m.subject_id
     WHERE m.space_id = ${spaceId}
     ORDER BY m.subject_type, lower(COALESCE(u.name, g.name))`;
}
```

If `checkUuid` does not already exist as an exported helper, extract it from the
existing `checkSubject` validation in this file so both use one canonical uuid
regex (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`) and
throw `HttpError(400, ...)`.

Add `VIEWER` and `requireSpace` to this file's imports from `./perm.ts` if absent.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && bun test test/perm.test.ts`
Expected: PASS, including the four new tests.

- [ ] **Step 5: Write the failing CORS test** — append to `apps/api/test/auth.test.ts`

```ts
test("CORS: preflight is answered for the dev origin", async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/api/auth/login`, {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:5183",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBe("http://localhost:5183");
    expect(r.headers.get("access-control-allow-credentials")).toBe("true");
    expect(r.headers.get("access-control-allow-methods")).toContain("PATCH");
    expect(r.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("content-type");
  });
});

test("CORS: an allowed origin gets credentialed headers on a real response", async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/api/health`, { headers: { origin: "http://localhost:5183" } });
    expect(r.headers.get("access-control-allow-origin")).toBe("http://localhost:5183");
    expect(r.headers.get("access-control-allow-credentials")).toBe("true");
    expect(r.headers.get("vary")?.toLowerCase()).toContain("origin");
  });
});

test("CORS: a foreign origin is NOT echoed back", async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/api/health`, { headers: { origin: "http://evil.example" } });
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
    expect(r.status).toBe(200); // same-origin/non-browser callers still work
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `cd apps/api && bun test test/auth.test.ts`
Expected: FAIL — no `access-control-allow-origin` header.

- [ ] **Step 7: Implement CORS in `apps/api/src/server.ts`**

Add near the top, and wrap the server's responses:

```ts
/**
 * Credentialed CORS for an explicit allowlist.
 *
 * `*` is not usable here: the session is an HttpOnly cookie, and browsers
 * reject `Allow-Credentials: true` alongside a wildcard origin. Echoing back
 * any Origin would let any site make credentialed calls on a user's behalf, so
 * the origin must be matched against the allowlist before it is echoed.
 */
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS ?? "http://localhost:5183")
  .split(",").map((s) => s.trim()).filter(Boolean);

export function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = { vary: "Origin" };
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    h["access-control-allow-origin"] = origin;
    h["access-control-allow-credentials"] = "true";
  }
  return h;
}

export function withCors(res: Response, origin: string | null): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

const preflight = (origin: string | null) =>
  new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(origin),
      "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "access-control-allow-headers": "content-type, authorization",
      "access-control-max-age": "600",
    },
  });
```

Then in `serve()`, handle preflight before routing and wrap every response:

```ts
export function serve(port = Number(process.env.PORT ?? 3011)) {
  return Bun.serve({
    port,
    routes: routes as any,
    async fetch(req) {
      const origin = req.headers.get("origin");
      if (req.method === "OPTIONS") return preflight(origin);
      return withCors(json({ error: "not found" }, 404), origin);
    },
  });
}
```

`Bun.serve`'s `routes` table bypasses `fetch` for matched routes, so route
responses need wrapping too. Do that inside the existing `route()` helper in
`src/http.ts`, which every handler already goes through:

```ts
export const route =
  (handler: Handler) =>
  async (req: Req): Promise<Response> => {
    const origin = req.headers.get("origin");
    try {
      return withCors(await handler(req), origin);
    } catch (e) {
      if (e instanceof HttpError) return withCors(json({ error: e.message }, e.status), origin);
      console.error("unhandled:", e);
      return withCors(json({ error: "internal error" }, 500), origin);
    }
  };
```

Import `withCors` into `http.ts` from `server.ts`, or — to avoid a circular
import — move `corsHeaders`/`withCors` into `src/http.ts` and import them into
`server.ts` instead. **Prefer moving them into `http.ts`.**

- [ ] **Step 8: Run the CORS tests**

Run: `cd apps/api && bun test test/auth.test.ts`
Expected: PASS, including the three new CORS tests.

- [ ] **Step 9: Add the three routes to `apps/api/src/server.ts`**

```ts
import { listGroupMembers, listGroups, listSpaceMembers } from "./spaces.ts";
```

Merge `GET` into the existing `/api/groups` and `/api/groups/:id/members`
entries (do **not** create duplicate keys), and into `/api/spaces/:id/members`:

```ts
  // inside "/api/groups":
    GET: route(async (req) => json(await listGroups(await requireUser(req)))),

  // inside "/api/groups/:id/members":
    GET: route(async (req) => json(await listGroupMembers(await requireUser(req), req.params.id))),

  // inside "/api/spaces/:id/members":
    GET: route(async (req) => json(await listSpaceMembers(await requireUser(req), req.params.id))),
```

- [ ] **Step 10: Add an HTTP-level test** — append to `apps/api/test/perm.test.ts`

```ts
test("the new list endpoints are reachable and admin-gated over HTTP", async () => {
  const admin = await makeUser({ admin: true });
  const plain = await makeUser();
  const g = await createGroup(admin as any, "eng");
  const space = await createSpace(plain as any, "S");

  await withServer(async (base) => {
    const asAdmin = { authorization: `Bearer ${admin.token}` };
    const asPlain = { authorization: `Bearer ${plain.token}` };

    expect((await fetch(`${base}/api/groups`, { headers: asAdmin })).status).toBe(200);
    expect((await fetch(`${base}/api/groups`, { headers: asPlain })).status).toBe(403);
    expect((await fetch(`${base}/api/groups`)).status).toBe(401);

    expect((await fetch(`${base}/api/groups/${g.id}/members`, { headers: asAdmin })).status).toBe(200);

    const m = await fetch(`${base}/api/spaces/${space.id}/members`, { headers: asPlain });
    expect(m.status).toBe(200);
    expect((await m.json()).length).toBe(1); // the creator, as OWNER

    const denied = await fetch(`${base}/api/spaces/${space.id}/members`, { headers: asAdmin });
    expect(denied.status).toBe(404); // admin is not a member; 404 not 403
  });
});
```

- [ ] **Step 11: Run the full API suite**

Run: `cd apps/api && bun test`
Expected: all pass (151 existing + 8 new).

- [ ] **Step 12: Verify no dependency crept in, then commit**

```bash
cd apps/api && node -e "const d=require('./package.json'); if(d.dependencies) { console.error('RUNTIME DEP ADDED'); process.exit(1); } console.log('ok: no runtime deps')"
bun run typecheck
cd ../.. && git add apps/api && git commit -m "feat(api): CORS and the missing group/member list endpoints"
```

---

### Task 2: Vite scaffold, fonts, design tokens, base styles

**Files:**
- Create: `apps/web/package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`
- Create: `apps/web/src/main.tsx`, `apps/web/src/App.tsx`
- Create: `apps/web/src/styles/tokens.css`, `apps/web/src/styles/base.css`
- Create: `apps/web/public/fonts/` (self-hosted woff2)
- Test: `apps/web/test/tokens.test.ts`

**Interfaces:**
- Produces: a running dev server on 5183 proxying nothing (the API is called cross-origin, which is why Task 1 added CORS); CSS custom properties consumed by every later component.

- [ ] **Step 1: Scaffold**

```bash
mkdir -p apps/web/src/styles apps/web/public/fonts apps/web/test apps/web/e2e
cd apps/web
npm init -y
npm i react react-dom react-router-dom @tanstack/react-query
npm i -D vite @vitejs/plugin-react typescript @types/react @types/react-dom \
        vitest @testing-library/react @testing-library/user-event @testing-library/jest-dom jsdom
```

- [ ] **Step 2: Write `apps/web/vite.config.ts`**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5183, strictPort: true },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    globals: true,
  },
});
```

- [ ] **Step 3: Write `apps/web/test/setup.ts`**

```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 4: Set scripts in `apps/web/package.json`**

```json
{
  "name": "@hdrive/web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 5: Vendor the fonts**

The mockup's `@font-face` rules point at design-tool asset ids with no payload,
so the fonts must come from their upstream source. Both are open-source (OFL).

Download the woff2 files for **Bricolage Grotesque** weights 400/500/600 and
**IBM Plex Mono** weight 400/500 (latin subset is sufficient) into
`apps/web/public/fonts/`. Name them
`bricolage-grotesque-{400,500,600}.woff2` and `ibm-plex-mono-{400,500}.woff2`.

```bash
cd apps/web/public/fonts
# Bricolage Grotesque and IBM Plex Mono, latin subset, from Google Fonts.
# Fetch the CSS with a modern UA so Google serves woff2, then pull the URLs it names:
curl -sL -A "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36" \
  "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,500;12..96,600&family=IBM+Plex+Mono:wght@400;500&display=swap" \
  -o /tmp/hdrive-fonts.css
grep -oE 'https://[^)]+\.woff2' /tmp/hdrive-fonts.css | sort -u
```

Download each URL and save under the names above. If the network is
unavailable, stop and report it — do **not** substitute different typefaces or
silently fall back to system fonts; the design's typography is load-bearing and
a swap must be a visible decision, not a default.

- [ ] **Step 6: Write `apps/web/src/styles/tokens.css`**

Values are transcribed from `docs/references/design-extraction.md` §4. Do not
invent additions.

```css
:root {
  /* Brand */
  --brand:            #3B3BE8;
  --brand-hover:      #2323C4;
  --brand-tint:       #EEEEFD;
  --brand-tint-2:     #DEDEFB;
  --brand-tint-3:     #F7F7FE;

  /* Text */
  --text:             #14161A;
  --text-secondary:   #5B6169;
  --text-tertiary:    #8A9099;

  /* Surfaces & borders */
  --bg:               #F4F5F7;
  --surface:          #FFFFFF;
  --surface-subtle:   #F9FAFB;
  --border:           #E3E5EA;
  --border-strong:    #C9CDD4;
  --divider:          #EDEFF2;

  /* Semantic */
  --success:          #1F7A4C;
  --success-tint:     #E8F5EE;
  --danger:           #B4232E;
  --danger-tint:      #FDF0F1;
  --warning:          #C2410C;
  --warning-tint:     #FDE7D6;

  /* Visibility tiers — colour unchanged from the mockup; copy corrected in the UI */
  --vis-space:        #5B6169;  --vis-space-bg:  #EDEFF2;  --vis-space-dot:  #8A9099;
  --vis-shared:       #3B3BE8;  --vis-shared-bg: #EEEEFD;  --vis-shared-dot: #3B3BE8;
  --vis-public:       #1F7A4C;  --vis-public-bg: #E8F5EE;  --vis-public-dot: #1F7A4C;

  /* Dark sidebar variant (the only dark surface in the mockup) */
  --sidebar-dark-bg:        #14161A;
  --sidebar-dark-border:    #22252B;
  --sidebar-dark-text:      #FFFFFF;
  --sidebar-dark-inactive:  #9AA0A8;
  --sidebar-dark-active-bg: #22252B;

  /* Type */
  --font-ui:   'Bricolage Grotesque', system-ui, -apple-system, 'Segoe UI', sans-serif;
  --font-mono: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;

  /* Radii */
  --r-chip: 6px;  --r-control: 8px;  --r-card: 12px;  --r-modal: 14px;  --r-pill: 999px;

  /* Shadows */
  --shadow-tab:      0 1px 2px rgba(20,22,26,0.09);
  --shadow-dropdown: 0 12px 32px rgba(20,22,26,0.14);
  --shadow-toast:    0 16px 40px rgba(20,22,26,0.16);
  --shadow-modal:    0 24px 64px rgba(20,22,26,0.28);

  /* Motion */
  --rise: 0.15s ease-out;
}
```

- [ ] **Step 7: Write `apps/web/src/styles/base.css`**

```css
@font-face { font-family:'Bricolage Grotesque'; src:url('/fonts/bricolage-grotesque-400.woff2') format('woff2'); font-weight:400; font-display:swap; }
@font-face { font-family:'Bricolage Grotesque'; src:url('/fonts/bricolage-grotesque-500.woff2') format('woff2'); font-weight:500; font-display:swap; }
@font-face { font-family:'Bricolage Grotesque'; src:url('/fonts/bricolage-grotesque-600.woff2') format('woff2'); font-weight:600; font-display:swap; }
@font-face { font-family:'IBM Plex Mono'; src:url('/fonts/ibm-plex-mono-400.woff2') format('woff2'); font-weight:400; font-display:swap; }
@font-face { font-family:'IBM Plex Mono'; src:url('/fonts/ibm-plex-mono-500.woff2') format('woff2'); font-weight:500; font-display:swap; }

*, *::before, *::after { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-ui);
  font-size: 14px;
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
}

a { color: var(--brand); text-decoration: none; }
a:hover { color: var(--brand-hover); text-decoration: underline; }

::selection { background: var(--brand-tint-2); }

:focus-visible { outline: 2px solid var(--brand); outline-offset: 0; }

/* Uppercase micro-labels: column headers, metadata, counters. */
.mono-label {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-tertiary);
}

@keyframes hdRise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes hdSpin { to { transform: rotate(360deg); } }

.rise { animation: hdRise var(--rise); }
.spin { animation: hdSpin 0.9s linear infinite; }

@media (prefers-reduced-motion: reduce) {
  .rise, .spin { animation: none; }
  * { transition-duration: 0.01ms !important; }
}
```

The mockup applies hover styles via a templating attribute rather than CSS.
Implement hover as real CSS `:hover` with a transition, per
`design-extraction.md` §4 motion notes.

- [ ] **Step 8: Write `apps/web/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Hdrive</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 9: Write `apps/web/src/main.tsx` and a placeholder `App.tsx`**

```tsx
// main.tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./styles/tokens.css";
import "./styles/base.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
```

```tsx
// App.tsx — replaced in Task 5 by the real shell and routes.
export default function App() {
  return <div style={{ padding: 28 }}>Hdrive</div>;
}
```

- [ ] **Step 10: Write the token test** — `apps/web/test/tokens.test.ts`

This guards against a token being renamed or dropped, which would silently fall
back to an inherited colour rather than erroring.

```ts
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const css = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");

test("every token the design depends on is defined", () => {
  for (const name of [
    "--brand", "--brand-hover", "--brand-tint",
    "--text", "--text-secondary", "--text-tertiary",
    "--bg", "--surface", "--border", "--divider",
    "--success", "--danger", "--warning",
    "--vis-space", "--vis-shared", "--vis-public",
    "--font-ui", "--font-mono",
    "--r-control", "--r-card", "--r-modal", "--r-pill",
    "--shadow-modal", "--shadow-toast", "--shadow-dropdown",
  ]) {
    expect(css).toContain(`${name}:`);
  }
});

test("brand and visibility colours match the extracted design exactly", () => {
  expect(css).toMatch(/--brand:\s*#3B3BE8/i);
  expect(css).toMatch(/--brand-hover:\s*#2323C4/i);
  expect(css).toMatch(/--vis-shared:\s*#3B3BE8/i);
  expect(css).toMatch(/--vis-public:\s*#1F7A4C/i);
  expect(css).toMatch(/--vis-space:\s*#5B6169/i);
});
```

- [ ] **Step 11: Verify the app boots and tests pass**

```bash
cd apps/web
npm run typecheck
npm test
npm run build
```

Expected: typecheck clean, 2 tests pass, build succeeds.

Then `npm run dev` and confirm http://localhost:5183 renders "Hdrive" in
Bricolage Grotesque (check the Network tab shows the woff2 files loading, not a
system-font fallback). Stop the server.

- [ ] **Step 12: Commit**

```bash
git add apps/web && git commit -m "feat(web): Vite scaffold, self-hosted fonts, and design tokens"
```

---

### Task 3: API client, types, and error normalisation

**Files:**
- Create: `apps/web/src/api/types.ts`, `errors.ts`, `client.ts`
- Test: `apps/web/test/client.test.ts`

**Interfaces:**
- Produces:
  - `class ApiError extends Error { status: number; body: {error?: string} }`
  - `isNotFound(e)`, `isForbidden(e)`, `isUnauthorized(e)`, `isConflict(e)` — type guards
  - `api.get<T>(path)`, `api.post<T>(path, body?)`, `api.patch<T>(path, body?)`, `api.del<T>(path, body?)`
  - `API_BASE: string`
  - Types: `User`, `Space`, `Item`, `Grant`, `ShareLink`, `SpaceMember`, `Group`, `Backend`, `ProbeResult`

- [ ] **Step 1: Write `apps/web/src/api/types.ts`**

Hand-written to match the API's actual responses. Roles are integers.

```ts
export const VIEWER = 1, EDITOR = 2, OWNER = 3;
export type Role = 1 | 2 | 3;

export type User = { id: string; email: string; name: string; is_admin: boolean };
export type Space = { id: string; name: string; created_at: string };

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

export type Subject = { type: "user" | "group"; id: string };
export type Grant = { subject_type: "user" | "group"; subject_id: string; role: Role };

export type SpaceMember = {
  subject_type: "user" | "group";
  subject_id: string;
  role: Role;
  name: string;
  email: string | null;
};

export type Group = { id: string; name: string; created_at: string; member_count: number };

export type ShareLink = {
  id: string;
  mode: "view" | "download";
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
  has_password: boolean;
};
/** Returned ONCE at creation; the raw token is never retrievable again. */
export type CreatedShareLink = ShareLink & { token: string };

export type Backend = {
  id: string; name: string; provider: string;
  is_write_target: boolean; created_at: string; item_count: number;
};
export type ProbeStep = { step: string; ok: boolean; detail?: string };
export type ProbeResult = { ok: boolean; steps: ProbeStep[] };

export type UploadTicket = { item_id: string; url: string; expires_in: number };
```

- [ ] **Step 2: Write `apps/web/src/api/errors.ts`**

```ts
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: { error?: string } = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;
const at = (e: unknown, s: number) => isApiError(e) && e.status === s;

export const isUnauthorized = (e: unknown) => at(e, 401);
export const isForbidden = (e: unknown) => at(e, 403);
/**
 * The API returns 404 for "no access" as well as "does not exist", deliberately,
 * so the UI must render a not-found state and must never say "forbidden" here —
 * doing so would leak the existence the API hides.
 */
export const isNotFound = (e: unknown) => at(e, 404);
export const isConflict = (e: unknown) => at(e, 409);
export const isUnavailable = (e: unknown) => at(e, 503);
```

- [ ] **Step 3: Write the failing test** — `apps/web/test/client.test.ts`

```ts
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../src/api/client";
import { ApiError, isConflict, isNotFound, isUnauthorized } from "../src/api/errors";

const mockFetch = (status: number, body: unknown, headers: Record<string,string> = {}) =>
  vi.fn().mockResolvedValue(
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    }),
  );

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); });

test("GET returns parsed JSON", async () => {
  vi.stubGlobal("fetch", mockFetch(200, { id: "x" }));
  expect(await api.get<{ id: string }>("/api/items/x")).toEqual({ id: "x" });
});

test("every request sends credentials, so the session cookie travels", async () => {
  const f = mockFetch(200, {});
  vi.stubGlobal("fetch", f);
  await api.get("/api/auth/me");
  expect(f.mock.calls[0][1].credentials).toBe("include");
});

test("a 204 resolves to null rather than failing to parse", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
  expect(await api.del("/api/shares/abc")).toBeNull();
});

test("an error status becomes a typed ApiError carrying the API's message", async () => {
  vi.stubGlobal("fetch", mockFetch(409, { error: "an item with that name already exists here" }));
  const err = await api.post("/api/spaces/s/folders", { name: "x" }).catch((e) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err.status).toBe(409);
  expect(err.message).toBe("an item with that name already exists here");
  expect(isConflict(err)).toBe(true);
});

test("guards distinguish the statuses the UI branches on", async () => {
  for (const [status, guard] of [[401, isUnauthorized], [404, isNotFound]] as const) {
    vi.stubGlobal("fetch", mockFetch(status, { error: "nope" }));
    const e = await api.get("/api/items/x").catch((x) => x);
    expect(guard(e)).toBe(true);
  }
});

test("a non-JSON error body still produces an ApiError with the status", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    new Response("<html>502</html>", { status: 502, headers: { "content-type": "text/html" } }),
  ));
  const e = await api.get("/api/health").catch((x) => x);
  expect(e).toBeInstanceOf(ApiError);
  expect(e.status).toBe(502);
});

test("a network failure surfaces as an ApiError, not a raw TypeError", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
  const e = await api.get("/api/health").catch((x) => x);
  expect(e).toBeInstanceOf(ApiError);
  expect(e.status).toBe(0);
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `cd apps/web && npm test`
Expected: FAIL — cannot resolve `../src/api/client`.

- [ ] **Step 5: Write `apps/web/src/api/client.ts`**

```ts
import { ApiError } from "./errors";

export const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3011";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      // The session is an HttpOnly cookie; without this every call is anonymous.
      credentials: "include",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    // Offline, DNS failure, or a CORS rejection — all arrive as TypeError.
    throw new ApiError(0, e instanceof Error ? e.message : "network error");
  }

  if (res.status === 204 || res.headers.get("content-length") === "0") {
    if (!res.ok) throw new ApiError(res.status, res.statusText || "request failed");
    return null as T;
  }

  const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
  const payload = isJson ? await res.json().catch(() => ({})) : null;

  if (!res.ok) {
    const message = (payload as any)?.error ?? res.statusText ?? "request failed";
    throw new ApiError(res.status, message, (payload as any) ?? {});
  }
  return payload as T;
}

export const api = {
  get:   <T>(path: string) => request<T>("GET", path),
  post:  <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  del:   <T>(path: string, body?: unknown) => request<T>("DELETE", path, body),
};
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd apps/web && npm test`
Expected: 9 pass (2 token + 7 client).

- [ ] **Step 7: Break a predicate, confirm a test fails, restore**

Remove `credentials: "include"` and confirm the credentials test fails; restore.
Change the error path to `throw new Error(...)` instead of `ApiError` and confirm
the guard tests fail; restore. Report which test caught which.

- [ ] **Step 8: Commit**

```bash
git add apps/web && git commit -m "feat(web): typed API client with normalised errors"
```

---

### Task 4: Auth — sign-in, session, protected routes

**Files:**
- Create: `apps/web/src/api/queries.ts` (auth hooks)
- Create: `apps/web/src/routes/SignIn.tsx`
- Create: `apps/web/src/components/RequireAuth.tsx`
- Test: `apps/web/test/auth.test.tsx`

**Interfaces:**
- Consumes: `api`, `ApiError`, `isUnauthorized`, `User`.
- Produces: `useMe()`, `useLogin()`, `useLogout()`, `<RequireAuth>`, `<SignIn>`.

**Design:** the mockup's split auth layout — brand-blue left panel, form card on
the right — with **email + password fields replacing the Google button**, and
**no signup link** (registration is admin-only).

- [ ] **Step 1: Write the failing test** — `apps/web/test/auth.test.tsx`

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import RequireAuth from "../src/components/RequireAuth";
import SignIn from "../src/routes/SignIn";

const wrap = (ui: React.ReactNode, initial = "/") =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[initial]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );

afterEach(() => vi.unstubAllGlobals());

test("sign-in offers email and password, and no signup link", () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
  wrap(<SignIn />);
  expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
  expect(screen.queryByText(/sign up|create account|continue with google/i)).toBeNull();
});

test("a failed sign-in shows the API's message and does not navigate", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ error: "invalid credentials" }), {
      status: 401, headers: { "content-type": "application/json" },
    }),
  ));
  wrap(<SignIn />);
  await userEvent.type(screen.getByLabelText(/email/i), "a@b.com");
  await userEvent.type(screen.getByLabelText(/password/i), "wrongpassword");
  await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
  expect(await screen.findByText(/invalid credentials/i)).toBeInTheDocument();
});

test("RequireAuth renders a redirect target for an anonymous visitor", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ error: "not authenticated" }), {
      status: 401, headers: { "content-type": "application/json" },
    }),
  ));
  wrap(
    <Routes>
      <Route path="/signin" element={<div>sign in page</div>} />
      <Route element={<RequireAuth />}>
        <Route path="/" element={<div>secret</div>} />
      </Route>
    </Routes>,
    "/",
  );
  expect(await screen.findByText("sign in page")).toBeInTheDocument();
  expect(screen.queryByText("secret")).toBeNull();
});

test("RequireAuth renders children for a signed-in user", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ id: "u1", email: "a@b.com", name: "A", is_admin: false }), {
      status: 200, headers: { "content-type": "application/json" },
    }),
  ));
  wrap(
    <Routes>
      <Route path="/signin" element={<div>sign in page</div>} />
      <Route element={<RequireAuth />}>
        <Route path="/" element={<div>secret</div>} />
      </Route>
    </Routes>,
    "/",
  );
  expect(await screen.findByText("secret")).toBeInTheDocument();
});

test("while the session is being checked, neither content nor the sign-in page flashes", async () => {
  let resolve!: (r: Response) => void;
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise((r) => { resolve = r; })));
  wrap(
    <Routes>
      <Route path="/signin" element={<div>sign in page</div>} />
      <Route element={<RequireAuth />}>
        <Route path="/" element={<div>secret</div>} />
      </Route>
    </Routes>,
    "/",
  );
  expect(screen.queryByText("secret")).toBeNull();
  expect(screen.queryByText("sign in page")).toBeNull();
  resolve(new Response(JSON.stringify({ id: "u1", email: "a@b.com", name: "A", is_admin: false }),
    { status: 200, headers: { "content-type": "application/json" } }));
  await waitFor(() => expect(screen.getByText("secret")).toBeInTheDocument());
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npm test`
Expected: FAIL — cannot resolve `../src/routes/SignIn`.

- [ ] **Step 3: Add auth hooks to `apps/web/src/api/queries.ts`**

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import { isUnauthorized } from "./errors";
import type { User } from "./types";

export function useMe() {
  return useQuery<User | null>({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        return await api.get<User>("/api/auth/me");
      } catch (e) {
        // Anonymous is a normal state, not an error the UI should surface.
        if (isUnauthorized(e)) return null;
        throw e;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { email: string; password: string }) =>
      api.post<{ user: User }>("/api/auth/login", v),
    onSuccess: (data) => qc.setQueryData(["me"], data.user),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<null>("/api/auth/logout"),
    onSuccess: () => { qc.setQueryData(["me"], null); qc.clear(); },
  });
}
```

- [ ] **Step 4: Write `apps/web/src/components/RequireAuth.tsx`**

```tsx
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useMe } from "../api/queries";

export default function RequireAuth() {
  const { data: me, isPending } = useMe();
  const loc = useLocation();

  // Render nothing while the session is resolving: showing either the app or
  // the sign-in page here causes a visible flash on every load.
  if (isPending) return null;
  if (!me) return <Navigate to="/signin" replace state={{ from: loc.pathname }} />;
  return <Outlet />;
}
```

- [ ] **Step 5: Write `apps/web/src/routes/SignIn.tsx`**

```tsx
import { type FormEvent, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useLogin } from "../api/queries";
import { isApiError } from "../api/errors";

export default function SignIn() {
  const login = useLogin();
  const nav = useNavigate();
  const loc = useLocation() as { state?: { from?: string } };
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate({ email, password }, {
      onSuccess: () => nav(loc.state?.from ?? "/", { replace: true }),
    });
  };

  const message = isApiError(login.error) ? login.error.message : null;

  return (
    <div className="auth">
      <aside className="auth-panel">
        <div className="auth-brand">hdrive</div>
        <h1>Everything your team ships, in one place.</h1>
      </aside>

      <main className="auth-main">
        <form className="auth-card rise" onSubmit={onSubmit} noValidate>
          <h2>Sign in</h2>

          <label htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="username" required
                 value={email} onChange={(e) => setEmail(e.target.value)} />

          <label htmlFor="password">Password</label>
          <input id="password" type="password" autoComplete="current-password" required
                 value={password} onChange={(e) => setPassword(e.target.value)} />

          {message && <p role="alert" className="auth-error">{message}</p>}

          <button type="submit" disabled={login.isPending}>
            {login.isPending ? "Signing in…" : "Sign in"}
          </button>

          <p className="auth-hint">
            Accounts are created by an administrator.
          </p>
        </form>
      </main>
    </div>
  );
}
```

Style it in `apps/web/src/styles/auth.css` (imported from this file) using the
tokens: left panel `background: var(--brand)` with `#D6D6FB` secondary text, hero
`font-size: 40px; line-height: 1.05; letter-spacing: -0.03em`, card
`background: var(--surface); border-radius: var(--r-modal); box-shadow: var(--shadow-modal); padding: 28px`,
inputs `border: 1px solid var(--border); border-radius: var(--r-control); padding: 10px 12px; font-size: 14px`,
button `background: var(--brand); color: #fff; border-radius: var(--r-control); font-weight: 600`
with `:hover { background: var(--brand-hover); }`, error text `color: var(--danger)`.

- [ ] **Step 6: Run the tests**

Run: `cd apps/web && npm test`
Expected: 14 pass.

- [ ] **Step 7: Break a predicate, confirm a test fails, restore**

Change `if (isPending) return null;` to fall through to the redirect and confirm
the no-flash test fails. Restore.

- [ ] **Step 8: Commit**

```bash
git add apps/web && git commit -m "feat(web): email+password sign-in and route guards"
```

---

### Task 5: App shell — sidebar, header, routing

**Files:**
- Create: `apps/web/src/routes/AppShell.tsx`
- Create: `apps/web/src/components/Sidebar.tsx`, `Header.tsx`, `Avatar.tsx`
- Modify: `apps/web/src/App.tsx` (the real route table)
- Test: `apps/web/test/shell.test.tsx`

**Interfaces:**
- Consumes: `useMe`, `useLogout`, `useSpaces` (added here).
- Produces: `<AppShell>`, `<Sidebar>`, `<Header>`, `<Avatar>`, `useSpaces()`, and the route table.

**Routes** (real URLs — the mockup has none):

```
/signin
/                      → redirect to the first space
/s/:spaceId            → Files (root)
/s/:spaceId/f/:itemId  → Files (inside a folder)
/s/:spaceId/trash      → Trash
/i/:itemId             → Video / file detail
/settings              → Account settings
/admin/backends  /admin/users  /admin/groups
/share/:token          → public unlock + view (no shell)
```

- [ ] **Step 1: Add `useSpaces` to `apps/web/src/api/queries.ts`**

```ts
import type { Space } from "./types";

export function useSpaces() {
  return useQuery<Space[]>({ queryKey: ["spaces"], queryFn: () => api.get<Space[]>("/api/spaces") });
}
```

- [ ] **Step 2: Write the failing test** — `apps/web/test/shell.test.tsx`

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import Sidebar from "../src/components/Sidebar";

const wrap = (ui: React.ReactNode, initial = "/s/space-1") =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[initial]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );

const admin = { id: "u1", email: "a@b.com", name: "A", is_admin: true };
const plain = { ...admin, is_admin: false };

afterEach(() => vi.unstubAllGlobals());

test("the sidebar shows the mockup's nav sections", () => {
  wrap(<Sidebar me={plain as any} spaceId="space-1" />);
  for (const label of [/my files/i, /shared/i, /recent/i, /trash/i]) {
    expect(screen.getByText(label)).toBeInTheDocument();
  }
});

test("admin navigation is hidden from non-admins and shown to admins", () => {
  const { unmount } = wrap(<Sidebar me={plain as any} spaceId="space-1" />);
  expect(screen.queryByText(/storage backends/i)).toBeNull();
  unmount();

  wrap(<Sidebar me={admin as any} spaceId="space-1" />);
  expect(screen.getByText(/storage backends/i)).toBeInTheDocument();
});

test("nav links point at the current space", () => {
  wrap(<Sidebar me={plain as any} spaceId="space-1" />);
  expect(screen.getByText(/trash/i).closest("a")).toHaveAttribute("href", "/s/space-1/trash");
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd apps/web && npm test`
Expected: FAIL — cannot resolve `../src/components/Sidebar`.

- [ ] **Step 4: Write `apps/web/src/components/Sidebar.tsx`**

```tsx
import { NavLink } from "react-router-dom";
import type { User } from "../api/types";

export default function Sidebar({ me, spaceId }: { me: User; spaceId: string }) {
  const item = (to: string, label: string, end = false) => (
    <NavLink to={to} end={end}
             className={({ isActive }) => `nav-item${isActive ? " is-active" : ""}`}>
      {label}
    </NavLink>
  );

  return (
    <nav className="sidebar">
      <div className="sidebar-brand">hdrive</div>

      <div className="nav-group">
        {item(`/s/${spaceId}`, "My files", true)}
        {item(`/s/${spaceId}?vis=shared`, "Shared")}
        {item(`/s/${spaceId}?sort=modified`, "Recent")}
        {item(`/s/${spaceId}/trash`, "Trash")}
      </div>

      {me.is_admin && (
        <>
          <div className="mono-label nav-heading">Admin</div>
          <div className="nav-group">
            {item("/admin/backends", "Storage backends")}
            {item("/admin/users", "Users")}
            {item("/admin/groups", "Groups")}
          </div>
        </>
      )}
    </nav>
  );
}
```

Style `.sidebar` per the mockup: fixed width 248px, `background: var(--surface)`,
`border-right: 1px solid var(--border)`; `.nav-item` 8px/10px padding,
`border-radius: var(--r-control)`, `color: var(--text-secondary)`;
`.nav-item.is-active` `background: var(--brand-tint); color: var(--brand); font-weight: 600`;
hover `background: var(--bg)` with `transition: background 0.15s`.

- [ ] **Step 5: Write `apps/web/src/components/Header.tsx` and `Avatar.tsx`**

```tsx
// Avatar.tsx — initials on a tinted background, per the mockup's avatar variants.
const TINTS = [
  ["#DEDEFB", "#3B3BE8"], ["#E4EEFB", "#1D4ED8"],
  ["#F3E8FF", "#6B21A8"], ["#FDE7D6", "#C2410C"], ["#E8F5EE", "#1F7A4C"],
] as const;

export default function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("");
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const [bg, fg] = TINTS[h % TINTS.length];
  return (
    <span className="avatar" aria-hidden="true"
          style={{ width: size, height: size, background: bg, color: fg, fontSize: size * 0.4 }}>
      {initials}
    </span>
  );
}
```

```tsx
// Header.tsx
import { useLogout } from "../api/queries";
import type { User } from "../api/types";
import Avatar from "./Avatar";

export default function Header({ me, title }: { me: User; title: string }) {
  const logout = useLogout();
  return (
    <header className="header">
      <h1>{title}</h1>
      <div className="header-right">
        <Avatar name={me.name} />
        <span>{me.name}</span>
        <button className="btn-ghost btn-danger" onClick={() => logout.mutate()}>Log out</button>
      </div>
    </header>
  );
}
```

- [ ] **Step 6: Write `apps/web/src/routes/AppShell.tsx` and the route table in `App.tsx`**

```tsx
// AppShell.tsx
import { Outlet, useParams } from "react-router-dom";
import { useMe } from "../api/queries";
import Sidebar from "../components/Sidebar";

export default function AppShell() {
  const { data: me } = useMe();
  const { spaceId } = useParams();
  if (!me) return null; // RequireAuth guarantees a user; this is a type narrow.
  return (
    <div className="shell">
      <Sidebar me={me} spaceId={spaceId ?? ""} />
      <div className="shell-main"><Outlet /></div>
    </div>
  );
}
```

```tsx
// App.tsx
import { Navigate, Route, Routes } from "react-router-dom";
import RequireAuth from "./components/RequireAuth";
import AppShell from "./routes/AppShell";
import SignIn from "./routes/SignIn";
import SpaceRedirect from "./routes/SpaceRedirect";

export default function App() {
  return (
    <Routes>
      <Route path="/signin" element={<SignIn />} />
      <Route element={<RequireAuth />}>
        <Route path="/" element={<SpaceRedirect />} />
        <Route element={<AppShell />}>
          {/* Files, Trash, Video, Settings, Admin routes are added in Tasks 6-11 */}
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
```

```tsx
// routes/SpaceRedirect.tsx — "/" has no meaning until a space is chosen.
import { Navigate } from "react-router-dom";
import { useSpaces } from "../api/queries";

export default function SpaceRedirect() {
  const { data: spaces, isPending } = useSpaces();
  if (isPending) return null;
  if (!spaces?.length) return <div className="empty">You are not a member of any space yet.</div>;
  return <Navigate to={`/s/${spaces[0].id}`} replace />;
}
```

- [ ] **Step 7: Write the space switcher** — `apps/web/src/components/SpaceSwitcher.tsx`

Spec §4 lists a workspace switcher. It sits at the top of the sidebar and
navigates between spaces; a user with one space still sees its name.

```tsx
import { useNavigate, useParams } from "react-router-dom";
import { useSpaces } from "../api/queries";

export default function SpaceSwitcher() {
  const { data: spaces } = useSpaces();
  const { spaceId } = useParams();
  const nav = useNavigate();
  if (!spaces?.length) return null;

  return (
    <label className="space-switcher">
      <span className="mono-label">Workspace</span>
      <select value={spaceId ?? spaces[0].id} onChange={(e) => nav(`/s/${e.target.value}`)}>
        {spaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </label>
  );
}
```

Render it in `Sidebar.tsx` directly beneath `.sidebar-brand`.

- [ ] **Step 8: Write account settings** — `apps/web/src/routes/Settings.tsx`

Spec §4 lists account settings. The API exposes no profile-update endpoint, so
this screen shows the signed-in identity and offers sign-out. **Do not build
fields the API cannot save** — a form that silently discards input is worse than
no form.

```tsx
import { useLogout, useMe } from "../api/queries";
import Avatar from "../components/Avatar";

export default function Settings() {
  const { data: me } = useMe();
  const logout = useLogout();
  if (!me) return null;

  return (
    <div className="settings">
      <h1>Account</h1>
      <div className="settings-identity">
        <Avatar name={me.name} size={48} />
        <div>
          <p className="settings-name">{me.name}</p>
          <p className="mono-label">{me.email}</p>
          {me.is_admin && <span className="pill">Administrator</span>}
        </div>
      </div>
      <p className="settings-hint">
        Your name and email are managed by an administrator.
      </p>
      <button className="btn-danger" onClick={() => logout.mutate()}>Log out</button>
    </div>
  );
}
```

Add `<Route path="/settings" element={<Settings />} />` inside the `AppShell`
block, and a sidebar link to it.

- [ ] **Step 9: Run tests, typecheck, build**

```bash
cd apps/web && npm test && npm run typecheck && npm run build
```

Expected: 17 pass, typecheck clean, build succeeds.

- [ ] **Step 10: Commit**

```bash
git add apps/web && git commit -m "feat(web): app shell, sidebar, and route table"
```

---

### Task 6: File browser — table, visibility badges, filters, empty states

**Files:**
- Create: `apps/web/src/lib/visibility.ts`, `apps/web/src/lib/format.ts`
- Create: `apps/web/src/components/VisibilityBadge.tsx`, `FileTable.tsx`, `EmptyState.tsx`
- Create: `apps/web/src/routes/Files.tsx`
- Modify: `apps/web/src/api/queries.ts`, `App.tsx`
- Test: `apps/web/test/visibility.test.ts`, `apps/web/test/files.test.tsx`

**Interfaces:**
- Consumes: `Item`, `Grant`, `ShareLink`, `api`.
- Produces:
  - `type Visibility = "space" | "shared" | "public"`
  - `computeVisibility(input: {grants: Grant[]; shares: ShareLink[]; now?: Date}): Visibility`
  - `isLiveShare(s: ShareLink, now?: Date): boolean`
  - `formatBytes(n: number | null): string`, `formatDate(iso: string): string`
  - `useChildren(spaceId, parentId)`, `<FileTable>`, `<VisibilityBadge>`, `<Files>`

**Copy (spec §3 — corrected from the mockup):** grey = **Space**, "Everyone in
{space}"; indigo = **Shared**, "Space members, plus {n} more"; green =
**Public**, "Anyone with the link, no sign-in".

- [ ] **Step 1: Write the failing test** — `apps/web/test/visibility.test.ts`

```ts
import { expect, test } from "vitest";
import { computeVisibility, isLiveShare } from "../src/lib/visibility";
import type { Grant, ShareLink } from "../src/api/types";

const NOW = new Date("2026-09-03T12:00:00Z");
const grant = (): Grant => ({ subject_type: "user", subject_id: "u1", role: 1 });
const share = (over: Partial<ShareLink> = {}): ShareLink => ({
  id: "s1", mode: "view", expires_at: null, revoked_at: null,
  created_at: "2026-09-01T00:00:00Z", has_password: false, ...over,
});

test("no grants and no links is Space", () => {
  expect(computeVisibility({ grants: [], shares: [], now: NOW })).toBe("space");
});

test("any grant is Shared", () => {
  expect(computeVisibility({ grants: [grant()], shares: [], now: NOW })).toBe("shared");
});

test("a live link is Public", () => {
  expect(computeVisibility({ grants: [], shares: [share()], now: NOW })).toBe("public");
});

test("Public wins over Shared — the badge shows the broadest exposure", () => {
  expect(computeVisibility({ grants: [grant()], shares: [share()], now: NOW })).toBe("public");
});

test("an expired link does not make an item Public", () => {
  const expired = share({ expires_at: "2026-09-02T00:00:00Z" });
  expect(computeVisibility({ grants: [], shares: [expired], now: NOW })).toBe("space");
  expect(computeVisibility({ grants: [grant()], shares: [expired], now: NOW })).toBe("shared");
});

test("a revoked link does not make an item Public", () => {
  const revoked = share({ revoked_at: "2026-09-02T00:00:00Z" });
  expect(computeVisibility({ grants: [], shares: [revoked], now: NOW })).toBe("space");
});

test("a never-expiring link is live", () => {
  expect(isLiveShare(share({ expires_at: null }), NOW)).toBe(true);
});

test("a link expiring exactly now is not live", () => {
  expect(isLiveShare(share({ expires_at: NOW.toISOString() }), NOW)).toBe(false);
});

test("one live link among dead ones still makes it Public", () => {
  const shares = [share({ revoked_at: "2026-09-02T00:00:00Z" }), share({ id: "s2" })];
  expect(computeVisibility({ grants: [], shares, now: NOW })).toBe("public");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npm test`
Expected: FAIL — cannot resolve `../src/lib/visibility`.

- [ ] **Step 3: Write `apps/web/src/lib/visibility.ts`**

```ts
import type { Grant, ShareLink } from "../api/types";

export type Visibility = "space" | "shared" | "public";

/**
 * A link is live only if it is neither revoked nor past its expiry.
 * `expires_at === null` means "never expires", which is a deliberate choice a
 * link's creator can make — not a missing value.
 */
export function isLiveShare(s: ShareLink, now: Date = new Date()): boolean {
  if (s.revoked_at) return false;
  if (s.expires_at && new Date(s.expires_at) <= now) return false;
  return true;
}

/**
 * The badge shows the BROADEST exposure, so Public outranks Shared.
 *
 * "Space" is the floor rather than "Private": the backend is grant-only with no
 * deny rules, so every member of a space can see everything in it. An item that
 * is private within a shared space is not representable — see spec §3.
 */
export function computeVisibility(input: {
  grants: Grant[];
  shares: ShareLink[];
  now?: Date;
}): Visibility {
  const now = input.now ?? new Date();
  if (input.shares.some((s) => isLiveShare(s, now))) return "public";
  if (input.grants.length > 0) return "shared";
  return "space";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && npm test`
Expected: 26 pass.

- [ ] **Step 5: Write `apps/web/src/lib/format.ts`**

```ts
export function formatBytes(n: number | null): string {
  if (n === null) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
```

- [ ] **Step 6: Write `apps/web/src/components/VisibilityBadge.tsx`**

```tsx
import type { Visibility } from "../lib/visibility";

const LABEL: Record<Visibility, string> = { space: "Space", shared: "Shared", public: "Public" };

export default function VisibilityBadge(
  { visibility, spaceName, extraCount = 0 }:
  { visibility: Visibility; spaceName?: string; extraCount?: number },
) {
  // Copy is corrected from the mockup: the backend cannot express "only you".
  const title =
    visibility === "space"  ? `Everyone in ${spaceName ?? "this space"}`
  : visibility === "shared" ? `Space members, plus ${extraCount} more`
  :                           "Anyone with the link, no sign-in";

  return (
    <span className={`vis vis-${visibility}`} title={title}>
      <span className="vis-dot" aria-hidden="true" />
      {LABEL[visibility]}
    </span>
  );
}
```

CSS, one rule per tier using the tokens:

```css
.vis { display:inline-flex; align-items:center; gap:6px; padding:3px 9px;
       border-radius: var(--r-pill); font-size:12px; font-weight:500; }
.vis-dot { width:6px; height:6px; border-radius:50%; }
.vis-space  { color: var(--vis-space);  background: var(--vis-space-bg); }
.vis-space  .vis-dot { background: var(--vis-space-dot); }
.vis-shared { color: var(--vis-shared); background: var(--vis-shared-bg); }
.vis-shared .vis-dot { background: var(--vis-shared-dot); }
.vis-public { color: var(--vis-public); background: var(--vis-public-bg); }
.vis-public .vis-dot { background: var(--vis-public-dot); }
```

- [ ] **Step 7: Add `useChildren` to `apps/web/src/api/queries.ts`**

```ts
import type { Item } from "./types";

export function useChildren(spaceId: string, parentId: string | null) {
  return useQuery<Item[]>({
    queryKey: ["children", spaceId, parentId],
    queryFn: () =>
      api.get<Item[]>(
        `/api/spaces/${spaceId}/children${parentId ? `?parent=${parentId}` : ""}`,
      ),
    enabled: Boolean(spaceId),
  });
}
```

- [ ] **Step 8: Write the failing table test** — `apps/web/test/files.test.tsx`

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, test } from "vitest";
import FileTable from "../src/components/FileTable";
import type { Item } from "../src/api/types";

const item = (over: Partial<Item> = {}): Item => ({
  id: "i1", space_id: "s1", parent_id: null, kind: "file", name: "report.pdf",
  path_ids: ["i1"], size: 2048, mime: "application/pdf",
  storage_backend_id: "b1", storage_key: "s1/i1", status: "ready",
  deleted_at: null, created_by: "u1", created_at: "2026-09-01T00:00:00Z", ...over,
});

const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );

test("renders the mockup's column headers as uppercase mono labels", () => {
  wrap(<FileTable items={[item()]} spaceId="s1" spaceName="Studio" />);
  for (const h of ["NAME", "OWNER", "VISIBILITY", "SIZE", "MODIFIED"]) {
    expect(screen.getByText(h)).toBeInTheDocument();
  }
});

test("shows a formatted size and a folder shows none", () => {
  wrap(<FileTable items={[item(), item({ id: "i2", kind: "folder", name: "Docs", size: null })]}
                  spaceId="s1" spaceName="Studio" />);
  expect(screen.getByText("2.0 KB")).toBeInTheDocument();
  expect(screen.getByText("—")).toBeInTheDocument();
});

test("a folder row links into the folder; a file row links to the item", () => {
  wrap(<FileTable items={[item({ id: "f1", kind: "folder", name: "Docs" }), item()]}
                  spaceId="s1" spaceName="Studio" />);
  expect(screen.getByText("Docs").closest("a")).toHaveAttribute("href", "/s/s1/f/f1");
  expect(screen.getByText("report.pdf").closest("a")).toHaveAttribute("href", "/i/i1");
});

test("pending uploads are not listed as if they were ready", () => {
  wrap(<FileTable items={[item({ status: "pending", name: "half.txt" })]}
                  spaceId="s1" spaceName="Studio" />);
  expect(screen.getByText(/uploading/i)).toBeInTheDocument();
});

test("an empty folder shows the empty state, not a bare table", () => {
  wrap(<FileTable items={[]} spaceId="s1" spaceName="Studio" />);
  expect(screen.getByText(/nothing here yet/i)).toBeInTheDocument();
  expect(screen.queryByText("NAME")).toBeNull();
});
```

- [ ] **Step 9: Write `FileTable.tsx` and `EmptyState.tsx`**

```tsx
// EmptyState.tsx
export default function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty-state">
      <p className="empty-title">{title}</p>
      {hint && <p className="empty-hint">{hint}</p>}
    </div>
  );
}
```

```tsx
// FileTable.tsx
import { Link } from "react-router-dom";
import type { Item } from "../api/types";
import { formatBytes, formatDate } from "../lib/format";
import EmptyState from "./EmptyState";
import VisibilityBadge from "./VisibilityBadge";

export default function FileTable(
  { items, spaceId, spaceName }: { items: Item[]; spaceId: string; spaceName: string },
) {
  if (items.length === 0) {
    return <EmptyState title="Nothing here yet" hint="Upload a file to get started." />;
  }

  return (
    <table className="file-table">
      <thead>
        <tr>
          {["NAME", "OWNER", "VISIBILITY", "SIZE", "MODIFIED"].map((h) => (
            <th key={h} className="mono-label">{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {items.map((it) => (
          <tr key={it.id}>
            <td>
              <Link to={it.kind === "folder" ? `/s/${spaceId}/f/${it.id}` : `/i/${it.id}`}>
                {it.name}
              </Link>
              {it.status === "pending" && <span className="pill-muted">Uploading…</span>}
            </td>
            <td>—</td>
            <td>
              {/* Grants and shares are fetched per item in Task 9; until then every
                  ready item is at least Space-visible. */}
              <VisibilityBadge visibility="space" spaceName={spaceName} />
            </td>
            <td>{it.kind === "folder" ? "—" : formatBytes(it.size)}</td>
            <td>{formatDate(it.created_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

Style the table per the mockup: header row `background: var(--surface-subtle)`,
`border-bottom: 1px solid var(--border)`; rows 13px vertical padding with
`border-bottom: 1px solid var(--divider)`; row hover `background: var(--bg)`.

- [ ] **Step 10: Write `apps/web/src/routes/Files.tsx` and wire the routes**

```tsx
import { useParams } from "react-router-dom";
import { useChildren, useSpaces } from "../api/queries";
import { isNotFound } from "../api/errors";
import FileTable from "../components/FileTable";
import EmptyState from "../components/EmptyState";

export default function Files() {
  const { spaceId = "", itemId = null } = useParams();
  const { data: spaces } = useSpaces();
  const { data: items, isPending, error } = useChildren(spaceId, itemId);

  const spaceName = spaces?.find((s) => s.id === spaceId)?.name ?? "this space";

  if (isPending) return null;
  // 404 covers "no access" as well as "does not exist" — never say "forbidden".
  if (error && isNotFound(error)) {
    return <EmptyState title="Not found" hint="This folder does not exist, or you do not have access." />;
  }
  if (error) return <EmptyState title="Something went wrong" hint={(error as Error).message} />;

  return <FileTable items={items ?? []} spaceId={spaceId} spaceName={spaceName} />;
}
```

Add inside the `<Route element={<AppShell />}>` block in `App.tsx`:

```tsx
<Route path="/s/:spaceId" element={<Files />} />
<Route path="/s/:spaceId/f/:itemId" element={<Files />} />
```

- [ ] **Step 11: Run everything**

```bash
cd apps/web && npm test && npm run typecheck && npm run build
```

Expected: 31 pass, typecheck clean, build succeeds.

- [ ] **Step 12: Break a predicate, confirm a test fails, restore**

Change `computeVisibility` to return `"shared"` before checking shares and
confirm the Public-wins test fails. Remove the `isLiveShare` revocation check and
confirm the revoked test fails. Restore both and report which caught which.

- [ ] **Step 13: Commit**

```bash
git add apps/web && git commit -m "feat(web): file browser with corrected visibility badges"
```

---

**Tasks 7–12 continue in `docs/superpowers/plans/2026-09-03-hdrive-frontend-part2.md`.**
