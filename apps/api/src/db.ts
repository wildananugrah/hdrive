import { SQL } from "bun";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

export const sql = new SQL(url, { max: 10 });

/**
 * Postgres uuid[] literal.
 *
 * Bun serializes JS arrays as `a,b` (no braces) and sql.array() produces
 * json[], neither of which casts to uuid[]. Building the literal is the only
 * form that works. Injection-safe by construction: any element that is not a
 * uuid is rejected by the ::uuid[] cast on the Postgres side.
 *
 * Always use with an explicit cast: ANY(${uuids(ids)}::uuid[])
 */
export const uuids = (ids: string[]) => `{${ids.join(",")}}`;

/** uuid[] columns come back as the raw literal string, not a JS array. */
export const parseUuids = (v: string | string[] | null): string[] => {
  if (Array.isArray(v)) return v;
  if (!v || v === "{}") return [];
  return v.slice(1, -1).split(",").filter(Boolean);
};
