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

/** Wraps a route so HttpError becomes a JSON response and nothing else leaks. */
export const route =
  (handler: Handler) =>
  async (req: Req): Promise<Response> => {
    try {
      return await handler(req);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error("unhandled:", e);
      return json({ error: "internal error" }, 500);
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
