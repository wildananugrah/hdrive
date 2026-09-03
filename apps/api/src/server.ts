import { body, bool, corsHeaders, json, route, str, withCors, type Req } from "./http.ts";
import {
  clearCookie, listUsers, login, logout, register, requireAdmin, requireUser,
  sessionCookie, setUserAdmin, tokenFrom,
} from "./auth.ts";
import { parseRole } from "./perm.ts";
import { createFolder, getItem, listChildren, listFolders, patchItem } from "./items.ts";
import { deleteItem, listTrash, restoreItem } from "./trash.ts";
import {
  createBackend, deleteBackend, listBackends, probeBackend, setWriteTarget, updateBackend,
} from "./backends.ts";
import {
  addGroupMember, addSpaceMember, createGroup, createSpace, grantItem,
  listGroupMembers, listGroups, listItemGrants, listSpaceMembers, listSpaces,
  removeGroupMember, removeSpaceMember, revokeItemGrant,
  type Subject,
} from "./spaces.ts";
import { beginUpload, completeUpload } from "./upload.ts";
import { serveContent, streamItem } from "./content.ts";
import {
  createShare, listShares, readUnlockCookie, resolveSharePublic,
  revokeShare, unlockCookieHeader, unlockShare,
} from "./share.ts";

export const routes = {
  "/api/health": { GET: route(async () => json({ ok: true })) },

  // Admin-only: an open registration lets a stranger create an account, then a
  // space they own, then upload into the org's shared write-target bucket.
  // register() itself stays unguarded so scripts/seed-admin.ts can bootstrap
  // the very first admin, when no admin exists to authorize the call.
  "/api/auth/register": {
    POST: route(async (req) => {
      await requireAdmin(req);
      const b = await body<Record<string, unknown>>(req);
      const email = str(b.email, "email");
      const password = str(b.password, "password");
      const name = str(b.name, "name");
      return json(await register(email, password, name), 201);
    }),
  },

  "/api/auth/login": {
    POST: route(async (req) => {
      const b = await body<Record<string, unknown>>(req);
      const email = str(b.email, "email");
      const password = str(b.password, "password");
      const { token, user } = await login(email, password);
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

  "/api/spaces": {
    GET: route(async (req) => json(await listSpaces((await requireUser(req)).id))),
    POST: route(async (req) => {
      const u = await requireUser(req);
      const b = await body<Record<string, unknown>>(req);
      return json(await createSpace(u, str(b.name, "name")), 201);
    }),
  },

  "/api/spaces/:id/members": {
    GET: route(async (req) => json(await listSpaceMembers(await requireUser(req), req.params.id))),
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
    GET: route(async (req) => json(await listGroups(await requireUser(req)))),
    POST: route(async (req) => {
      const u = await requireAdmin(req);
      const b = await body<Record<string, unknown>>(req);
      return json(await createGroup(u, str(b.name, "name")), 201);
    }),
  },

  "/api/groups/:id/members": {
    GET: route(async (req) => json(await listGroupMembers(await requireUser(req), req.params.id))),
    POST: route(async (req) => {
      const u = await requireAdmin(req);
      const b = await body<Record<string, unknown>>(req);
      await addGroupMember(u, req.params.id, str(b.user_id, "user_id"));
      return new Response(null, { status: 204 });
    }),
    DELETE: route(async (req) => {
      const u = await requireAdmin(req);
      const b = await body<Record<string, unknown>>(req);
      await removeGroupMember(u, req.params.id, str(b.user_id, "user_id"));
      return new Response(null, { status: 204 });
    }),
  },

  "/api/spaces/:id/children": {
    GET: route(async (req) => {
      const u = await requireUser(req);
      const parent = new URL(req.url).searchParams.get("parent");
      return json(await listChildren(u, req.params.id, parent));
    }),
  },

  "/api/spaces/:id/folders": {
    GET: route(async (req) => json(await listFolders(await requireUser(req), req.params.id))),
    POST: route(async (req) => {
      const u = await requireUser(req);
      const b = await body<{ name: string; parent_id?: string | null }>(req);
      return json(await createFolder(u, req.params.id, b.parent_id ?? null, b.name), 201);
    }),
  },

  "/api/items/:id": {
    GET: route(async (req) => json(await getItem(await requireUser(req), req.params.id))),
    PATCH: route(async (req) => {
      const u = await requireUser(req);
      const b = await body<{ name?: string; parent_id?: string | null }>(req);
      // One transaction: a rename must not commit when the move alongside it fails.
      return json(await patchItem(u, req.params.id, {
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.parent_id !== undefined ? { parent_id: b.parent_id } : {}),
      }));
    }),
    DELETE: route(async (req) => {
      await deleteItem(await requireUser(req), req.params.id);
      return new Response(null, { status: 204 });
    }),
  },

  "/api/items/:id/restore": {
    POST: route(async (req) => {
      await restoreItem(await requireUser(req), req.params.id);
      return new Response(null, { status: 204 });
    }),
  },

  "/api/spaces/:id/trash": {
    GET: route(async (req) => json(await listTrash(await requireUser(req), req.params.id))),
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

  "/api/spaces/:id/uploads": {
    POST: route(async (req) => {
      const u = await requireUser(req);
      const b = await body<{ name: string; parent_id?: string | null; mime?: string }>(req);
      return json(await beginUpload(u, req.params.id, b.parent_id ?? null, b.name, b.mime), 201);
    }),
  },

  "/api/items/:id/complete": {
    POST: route(async (req) => json(await completeUpload(await requireUser(req), req.params.id))),
  },

  "/api/items/:id/content": {
    GET: route(async (req) => {
      const u = await requireUser(req);
      const inline = new URL(req.url).searchParams.get("inline") === "1";
      return serveContent(u, req.params.id, req.headers.get("range"), inline ? "inline" : "attachment");
    }),
  },

  "/api/admin/users": {
    GET: route(async (req) => { await requireAdmin(req); return json(await listUsers()); }),
  },

  "/api/admin/users/:id": {
    PATCH: route(async (req) => {
      await requireAdmin(req);
      const b = await body<Record<string, unknown>>(req);
      return json(await setUserAdmin(req.params.id, bool(b.is_admin, "is_admin")));
    }),
  },

  "/api/admin/backends": {
    GET: route(async (req) => { await requireAdmin(req); return json(await listBackends()); }),
    POST: route(async (req) => {
      await requireAdmin(req);
      const b = await body<Record<string, unknown>>(req);
      return json(await createBackend({
        name: str(b.name, "name"),
        config: (b.config ?? {}) as any,
        makeWriteTarget: b.makeWriteTarget === true,
      }), 201);
    }),
  },

  "/api/admin/backends/:id": {
    PATCH: route(async (req) => {
      await requireAdmin(req);
      const b = await body<Record<string, unknown>>(req);
      const patch: { name?: string; config?: any } = {};
      if (b.name !== undefined) patch.name = str(b.name, "name");
      if (b.config !== undefined) patch.config = b.config;
      return json(await updateBackend(req.params.id, patch));
    }),
    DELETE: route(async (req) => {
      await requireAdmin(req);
      await deleteBackend(req.params.id);
      return new Response(null, { status: 204 });
    }),
  },

  "/api/admin/backends/:id/write-target": {
    POST: route(async (req) => {
      await requireAdmin(req);
      await setWriteTarget(req.params.id);
      return new Response(null, { status: 204 });
    }),
  },

  "/api/admin/backends/:id/probe": {
    POST: route(async (req) => {
      await requireAdmin(req);
      return json(await probeBackend(req.params.id));
    }),
  },

  "/api/items/:id/shares": {
    GET: route(async (req) => json(await listShares(await requireUser(req), req.params.id))),
    POST: route(async (req) => {
      const u = await requireUser(req);
      const b = await body<{ mode?: "view" | "download"; password?: string; expiresInDays?: number | null }>(req);
      return json(await createShare(u, req.params.id, b), 201);
    }),
  },

  "/api/shares/:id": {
    DELETE: route(async (req) => {
      await revokeShare(await requireUser(req), req.params.id);
      return new Response(null, { status: 204 });
    }),
  },

  // Public. Verifies a link's password and, on success, sets a short-lived
  // cookie scoped to that one link's URL — the password never travels as a
  // query parameter, so it never lands in access logs, proxy logs, browser
  // history, or a Referer header.
  "/s/:token/unlock": {
    POST: route(async (req) => {
      const b = await body<{ password?: unknown }>(req);
      const password = str(b.password ?? "", "password");
      const { cookieValue } = await unlockShare(req.params.token, password);
      if (!cookieValue) return new Response(null, { status: 204 });
      return new Response(null, {
        status: 204,
        headers: { "set-cookie": unlockCookieHeader(req.params.token, cookieValue) },
      });
    }),
  },

  // Public. The token is the only credential — no session on this route.
  // mode: 'view' vs 'download' only picks the Content-Disposition; it is a UX
  // hint, not access control, since anyone who can view can capture the bytes.
  "/s/:token": {
    GET: route(async (req) => {
      const cookie = readUnlockCookie(req.headers.get("cookie"));
      const { link, item } = await resolveSharePublic(req.params.token, cookie);
      return streamItem(item, req.headers.get("range"), link.mode === "view" ? "inline" : "attachment");
    }),
  },
};

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

if (import.meta.main) {
  const s = serve();
  console.log(`hdrive api on http://localhost:${s.port}`);
}
