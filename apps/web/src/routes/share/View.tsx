import { useEffect, useState } from "react";
import { API_BASE } from "../../api/client";

/**
 * Streams through the public route; the unlock cookie (if any) is already set
 * by Unlock, so the browser attaches it to this request automatically.
 *
 * mode: "view" only picks a Content-Disposition of "inline" server-side — a
 * speed bump for casual sharing, not access control, since anyone who can
 * view the stream can still capture it. Hiding the download button here is
 * just following that server hint, not enforcing anything.
 */
export default function ShareView({ token }: { token: string }) {
  const src = `${API_BASE}/s/${token}`;
  const [downloadable, setDownloadable] = useState(true);

  useEffect(() => {
    let cancelled = false;
    // A single-byte ranged request, just to read the Content-Disposition the
    // server already computed from the link's mode — cheap regardless of the
    // file's size, and avoids a second metadata endpoint for one header.
    fetch(src, { credentials: "include", headers: { range: "bytes=0-0" } })
      .then((r) => {
        if (!cancelled) {
          setDownloadable(!(r.headers.get("content-disposition") ?? "").startsWith("inline"));
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [src]);

  return (
    <main className="share-page">
      <div className="share-viewer">
        <video
          data-testid="share-video" src={src} crossOrigin="use-credentials"
          controls preload="metadata"
        />
        {downloadable && <a className="btn" href={src}>Download</a>}
      </div>
    </main>
  );
}
