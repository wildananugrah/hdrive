import { beforeEach, expect, test } from "bun:test";
import { login, register, requireUser } from "../src/auth.ts";
import { HttpError, type Req } from "../src/http.ts";
import { resetDb, withServer } from "./helpers.ts";

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
    const reg = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
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
