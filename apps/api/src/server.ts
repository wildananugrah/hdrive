import { body, json, route, str, type Req } from "./http.ts";
import {
  clearCookie, login, logout, register, requireAdmin, requireUser, sessionCookie, tokenFrom,
} from "./auth.ts";
import { parseRole } from "./perm.ts";
import { createFolder, getItem, listChildren, moveItem, renameItem } from "./items.ts";
import {
  addGroupMember, addSpaceMember, createGroup, createSpace, grantItem,
  listItemGrants, listSpaces, removeGroupMember, removeSpaceMember, revokeItemGrant,
  type Subject,
} from "./spaces.ts";

export const routes = {
  "/api/health": { GET: route(async () => json({ ok: true })) },

  "/api/auth/register": {
    POST: route(async (req) => {
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
      const u = await requireAdmin(req);
      const b = await body<Record<string, unknown>>(req);
      return json(await createGroup(u, str(b.name, "name")), 201);
    }),
  },

  "/api/groups/:id/members": {
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
      if (b.name !== undefined) await renameItem(u, req.params.id, b.name);
      if (b.parent_id !== undefined) await moveItem(u, req.params.id, b.parent_id);
      return json(await getItem(u, req.params.id));
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
