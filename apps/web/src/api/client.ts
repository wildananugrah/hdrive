import { ApiError } from "./errors";

export const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3011";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      // The session is an HttpOnly cookie; without this every call is anonymous.
      credentials: "include",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    // Offline, DNS failure, or a CORS rejection — all arrive as TypeError.
    throw new ApiError(0, e instanceof Error ? e.message : "network error");
  }

  if (res.status === 204 || res.headers.get("content-length") === "0") {
    if (!res.ok) throw new ApiError(res.status, res.statusText || "request failed");
    return null as T;
  }

  const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
  const payload = isJson ? await res.json().catch(() => ({})) : null;

  if (!res.ok) {
    const message = (payload as any)?.error ?? res.statusText ?? "request failed";
    throw new ApiError(res.status, message, (payload as any) ?? {});
  }
  return payload as T;
}

export const api = {
  get:   <T>(path: string) => request<T>("GET", path),
  post:  <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  del:   <T>(path: string, body?: unknown) => request<T>("DELETE", path, body),
};
