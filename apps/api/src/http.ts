export type Req = Request & { params: Record<string, string> };

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

export const json = (data: unknown, status = 200) => Response.json(data, { status });

export const sha256 = (s: string) =>
  new Bun.CryptoHasher("sha256").update(s).digest("hex");

type Handler = (req: Req) => Promise<Response> | Response;

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

/** Wraps a route so HttpError becomes a JSON response and nothing else leaks.
 *  Every response also gets CORS headers here — Bun.serve's routes table
 *  bypasses the top-level fetch handler for matched routes, so this is the one
 *  place all of them pass through. */
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

export async function body<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

/** Guards a body field is a string before it's passed to a trust-boundary function. */
export function str(value: unknown, field: string): string {
  if (typeof value !== "string") throw new HttpError(400, `${field} must be a string`);
  return value;
}

export function bool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new HttpError(400, `${field} must be a boolean`);
  return value;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A non-uuid reaching a uuid column is a Postgres 22P02, i.e. a 500 for what is
 *  really a bad request. Check before the query, not after. */
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);
