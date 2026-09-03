export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: { error?: string } = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;
const at = (e: unknown, s: number) => isApiError(e) && e.status === s;

export const isUnauthorized = (e: unknown) => at(e, 401);
export const isForbidden = (e: unknown) => at(e, 403);
/**
 * The API returns 404 for "no access" as well as "does not exist", deliberately,
 * so the UI must render a not-found state and must never say "forbidden" here —
 * doing so would leak the existence the API hides.
 */
export const isNotFound = (e: unknown) => at(e, 404);
export const isConflict = (e: unknown) => at(e, 409);
export const isUnavailable = (e: unknown) => at(e, 503);
