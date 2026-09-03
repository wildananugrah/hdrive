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
