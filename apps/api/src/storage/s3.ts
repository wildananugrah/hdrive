import { S3Client } from "bun";
import { HttpError } from "../http.ts";
import type { StorageBackend } from "./index.ts";

export type S3Config = {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  /** Most S3-compatible providers (MinIO included) need this false. */
  virtualHostedStyle?: boolean;
};

export function s3Backend(cfg: S3Config): StorageBackend {
  const c = new S3Client({
    endpoint: cfg.endpoint,
    bucket: cfg.bucket,
    region: cfg.region ?? "us-east-1",
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    virtualHostedStyle: cfg.virtualHostedStyle ?? false,
  });

  return {
    presignPut: (key, mime, expiresIn = 900) =>
      c.presign(key, { method: "PUT", type: mime, expiresIn }),

    head: async (key) => {
      try {
        const s = await c.stat(key);
        return { size: Number(s.size), mime: s.type || "application/octet-stream" };
      } catch (e: any) {
        // ONLY a genuine miss maps to null. Catching every S3Error would turn
        // an auth failure or a network fault into a silent "file is gone",
        // which the upload handshake would then report as a bad upload.
        if (e?.code === "NoSuchKey" || e?.code === "NotFound") return null;
        throw e;
      }
    },

    delete: async (key) => { await c.delete(key); },

    getStream: async (key, range) => {
      let stat;
      try {
        stat = await c.stat(key);
      } catch (e: any) {
        if (e?.code === "NoSuchKey" || e?.code === "NotFound")
          throw new HttpError(404, "object not found");
        throw e;
      }
      const total = Number(stat.size);
      const type = stat.type || "application/octet-stream";
      const f = c.file(key);

      const m = range?.match(/^bytes=(\d*)-(\d*)$/);
      if (!m) {
        return new Response(f.stream(), {
          headers: {
            "content-type": type,
            "content-length": String(total),
            "accept-ranges": "bytes",
          },
        });
      }

      let start: number;
      let end: number;
      if (m[1] === "") {
        // suffix range: "bytes=-500" means the LAST 500 bytes
        const n = Number(m[2]);
        if (!n) return rangeNotSatisfiable(total);
        start = Math.max(0, total - n);
        end = total - 1;
      } else {
        start = Number(m[1]);
        end = m[2] === "" ? total - 1 : Math.min(Number(m[2]), total - 1);
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total)
        return rangeNotSatisfiable(total);

      // HTTP Range end is INCLUSIVE; S3File.slice end is EXCLUSIVE.
      return new Response(f.slice(start, end + 1).stream(), {
        status: 206,
        headers: {
          "content-type": type,
          "content-length": String(end - start + 1),
          "content-range": `bytes ${start}-${end}/${total}`,
          "accept-ranges": "bytes",
        },
      });
    },
  };
}

const rangeNotSatisfiable = (total: number) =>
  new Response(null, { status: 416, headers: { "content-range": `bytes */${total}` } });
