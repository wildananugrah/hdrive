import { body, json, route, str, type Req } from "./http.ts";
import { clearCookie, login, logout, register, requireUser, sessionCookie, tokenFrom } from "./auth.ts";

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
