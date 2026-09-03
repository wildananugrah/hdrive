import { sql } from "./db.ts";
import { HttpError, type Req, sha256 } from "./http.ts";

const SESSION_DAYS = 30;

export type User = { id: string; email: string; name: string; is_admin: boolean };

const newToken = () =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

// Verified against when the email is unknown, so an unknown email costs the
// same argon2id verify as a known email with a wrong password (timing side-channel).
const DUMMY_HASH = await Bun.password.hash(crypto.randomUUID());

export async function register(email: string, password: string, name: string): Promise<User> {
  const normalized = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) throw new HttpError(400, "invalid email");
  if (password.length < 8) throw new HttpError(400, "password must be at least 8 characters");
  if (!name.trim()) throw new HttpError(400, "name is required");

  const password_hash = await Bun.password.hash(password); // argon2id
  try {
    const [u] = await sql`
      INSERT INTO users (email, password_hash, name)
      VALUES (${normalized}, ${password_hash}, ${name.trim()})
      RETURNING id, email, name, is_admin`;
    return u as User;
  } catch (e: any) {
    // Postgres exposes SQLSTATE on errno; code is always ERR_POSTGRES_SERVER_ERROR.
    if (e?.errno === "23505") throw new HttpError(409, "email already registered");
    throw e;
  }
}

export async function login(email: string, password: string) {
  const [u] = await sql`
    SELECT id, email, name, is_admin, password_hash FROM users
     WHERE email = ${email.trim().toLowerCase()}`;

  // Same error AND same wall-clock cost for unknown email vs. wrong password:
  // always verify, even against a dummy hash, so timing can't leak enumeration.
  const valid = await Bun.password.verify(password, u?.password_hash ?? DUMMY_HASH);
  if (!u || !valid) throw new HttpError(401, "invalid credentials");

  const token = newToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await sql`INSERT INTO sessions (id, user_id, expires_at)
            VALUES (${sha256(token)}, ${u.id}, ${expires})`;

  const user: User = { id: u.id, email: u.email, name: u.name, is_admin: u.is_admin };
  return { token, user };
}

export async function logout(token: string) {
  await sql`DELETE FROM sessions WHERE id = ${sha256(token)}`;
}

export function tokenFrom(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim() || null;
  const cookie = req.headers.get("cookie") ?? "";
  return cookie.match(/(?:^|;\s*)hd_session=([^;]+)/)?.[1] ?? null;
}

export async function requireUser(req: Req): Promise<User> {
  const token = tokenFrom(req);
  if (!token) throw new HttpError(401, "not authenticated");
  const [row] = await sql`
    SELECT u.id, u.email, u.name, u.is_admin
      FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ${sha256(token)} AND s.expires_at > now()`;
  if (!row) throw new HttpError(401, "not authenticated");
  return row as User;
}

export async function requireAdmin(req: Req): Promise<User> {
  const u = await requireUser(req);
  if (!u.is_admin) throw new HttpError(403, "admin only");
  return u;
}

export function sessionCookie(token: string) {
  const secure = process.env.COOKIE_SECURE === "true" ? "; Secure" : "";
  return `hd_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}

export const clearCookie = "hd_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
