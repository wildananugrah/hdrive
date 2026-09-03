import { beforeEach, expect, test } from "bun:test";
import { login, register, requireUser } from "../src/auth.ts";
import { HttpError, type Req } from "../src/http.ts";
import { sql } from "../src/db.ts";
import { makeUser, resetDb, withServer } from "./helpers.ts";

// Request.headers is a getter-only accessor in Bun 1.3.14, so it must be set
// via the constructor's init, not reassigned after the fact with Object.assign.
const asReq = (headers: Record<string, string>) =>
  Object.assign(new Request("http://x/", { headers }), { params: {} }) as Req;

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

test("login takes comparable time for an unknown email and a known email with a wrong password", async () => {
  await register("known@b.com", "hunter2hunter2", "K");

  const time = async (email: string, password: string) => {
    const start = performance.now();
    await login(email, password).catch(() => {});
    return performance.now() - start;
  };
  const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];

  const unknown: number[] = [];
  const wrongPassword: number[] = [];
  for (let i = 0; i < 5; i++) {
    unknown.push(await time(`ghost${i}@b.com`, "hunter2hunter2"));
    wrongPassword.push(await time("known@b.com", "wrongwrongwrong"));
  }

  const mUnknown = median(unknown);
  const mWrong = median(wrongPassword);
  // Generous 3x tolerance either direction so this doesn't flake on a loaded
  // machine, but tight enough to catch a skipped verify (near-instant reject).
  expect(mUnknown).toBeLessThan(mWrong * 3);
  expect(mWrong).toBeLessThan(mUnknown * 3);
});

test("requireUser rejects an expired session", async () => {
  await register("a@b.com", "hunter2hunter2", "Ada");
  const { token } = await login("a@b.com", "hunter2hunter2");
  const { sql } = await import("../src/db.ts");
  const { sha256 } = await import("../src/http.ts");
  await sql`UPDATE sessions SET expires_at = now() - interval '1 hour' WHERE id = ${sha256(token)}`;
  await expect(requireUser(asReq({ authorization: `Bearer ${token}` }))).rejects.toThrow();
});

test("auth endpoints work over HTTP", async () => {
  await withServer(async (base) => {
    // registration is admin-only now, so this leg carries an admin's token
    const admin = await makeUser({ admin: true });
    const reg = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${admin.token}` },
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

test("malformed bodies return 400, not 500", async () => {
  await withServer(async (base) => {
    const admin = await makeUser({ admin: true });
    for (const path of ["/api/auth/register", "/api/auth/login"]) {
      for (const badBody of [{}, { email: 123 }]) {
        const res = await fetch(`${base}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${admin.token}` },
          body: JSON.stringify(badBody),
        });
        expect(res.status).toBe(400);
      }
    }
  });
});

test("POST /api/auth/register is admin-only: 401 anonymous, 403 for a normal user, 201 for an admin", async () => {
  await withServer(async (base) => {
    const post = (auth?: string, email = `x${Math.random()}@b.com`) =>
      fetch(`${base}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
        body: JSON.stringify({ email, password: "hunter2hunter2", name: "N" }),
      });

    const anon = await post();
    expect(anon.status).toBe(401);

    const plain = await makeUser();
    expect((await post(plain.token)).status).toBe(403);

    const admin = await makeUser({ admin: true });
    expect((await post(admin.token)).status).toBe(201);

    // and the refused ones really did not create anything
    const [{ count }] = await sql`SELECT count(*)::int AS count FROM users`;
    expect(count).toBe(3); // plain + admin + the one the admin created
  });
});

test("GET /api/admin/users lists users without password_hash, and refuses a non-admin", async () => {
  await withServer(async (base) => {
    const admin = await makeUser({ admin: true });
    const plain = await makeUser();

    const forbidden = await fetch(`${base}/api/admin/users`, {
      headers: { authorization: `Bearer ${plain.token}` },
    });
    expect(forbidden.status).toBe(403);

    const res = await fetch(`${base}/api/admin/users`, {
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    const rows = JSON.parse(body);
    expect(rows.map((r: any) => r.id).sort()).toEqual([admin.id, plain.id].sort());
    expect(Object.keys(rows[0]).sort()).toEqual(["created_at", "email", "id", "is_admin", "name"]);
    expect(body).not.toContain("password_hash");
    expect(body).not.toContain("$argon2");
  });
});

test("PATCH /api/admin/users/:id promotes and demotes, refuses non-admins, and refuses emptying the admin set", async () => {
  await withServer(async (base) => {
    const admin = await makeUser({ admin: true });
    const plain = await makeUser();
    const patch = (token: string, id: string, is_admin: boolean) =>
      fetch(`${base}/api/admin/users/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ is_admin }),
      });

    expect((await patch(plain.token, plain.id, true)).status).toBe(403);
    expect((await sql`SELECT is_admin FROM users WHERE id = ${plain.id}`)[0].is_admin).toBe(false);

    const promoted = await patch(admin.token, plain.id, true);
    expect(promoted.status).toBe(200);
    expect((await promoted.json()).is_admin).toBe(true);

    const demoted = await patch(admin.token, plain.id, false);
    expect(demoted.status).toBe(200);
    expect((await demoted.json()).is_admin).toBe(false);

    // now `admin` is the only admin left: demoting them is refused, and sticks
    const last = await patch(admin.token, admin.id, false);
    expect(last.status).toBe(409);
    expect((await sql`SELECT is_admin FROM users WHERE id = ${admin.id}`)[0].is_admin).toBe(true);

    // a non-boolean is a 400, not a 500
    const bad = await fetch(`${base}/api/admin/users/${plain.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({ is_admin: "yes" }),
    });
    expect(bad.status).toBe(400);

    // an unknown (and a non-uuid) id is a 404, not a 500
    expect((await patch(admin.token, crypto.randomUUID(), true)).status).toBe(404);
    expect((await patch(admin.token, "not-a-uuid", true)).status).toBe(404);
  });
});
