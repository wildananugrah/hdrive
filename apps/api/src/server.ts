import { body, json, route, str, type Req } from "./http.ts";
import {
  clearCookie, login, logout, register, requireAdmin, requireUser, sessionCookie, tokenFrom,
} from "./auth.ts";
import { parseRole } from "./perm.ts";
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
