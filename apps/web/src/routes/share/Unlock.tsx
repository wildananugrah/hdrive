import { type FormEvent, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { API_BASE } from "../../api/client";
import ShareView from "./View";
import "../../styles/share.css";

type Phase = "checking" | "form" | "unlocked" | "notfound";

// Public page, no app chrome: a share recipient is not signed in, so this
// deliberately renders no Sidebar/Header — see App.tsx, this route sits
// outside RequireAuth.
export default function Unlock() {
  const { token = "" } = useParams();
  const [password, setPassword] = useState("");
  // Starts "checking", not "form": the backend skips password verification
  // when a link has none, so an unconditional prompt forces every recipient
  // of a no-password link through a click (and the nginx unlock rate limit)
  // for nothing. One probe POST on mount with an empty password tells us
  // which page to show — "checking" keeps the form from flashing before
  // that resolves.
  const [phase, setPhase] = useState<Phase>("checking");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const attempt = async (pw: string, isProbe: boolean) => {
    if (!isProbe) { setBusy(true); setError(null); }
    try {
      const r = await fetch(`${API_BASE}/s/${token}/unlock`, {
        method: "POST",
        // The unlock cookie is short-lived and path-scoped; without
        // credentials: "include" it's dropped and GET /s/:token 401s right
        // after a "successful" unlock.
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      if (r.ok) { setPhase("unlocked"); return; }

      const payload = await r.json().catch(() => ({}));
      // Show exactly what the API said. unknown/expired/revoked/trashed all
      // return the SAME 404 on purpose; inventing a more specific message
      // here ("this link expired", "this link was revoked") would leak a
      // distinction the API deliberately refuses to disclose.
      const message = payload.error ?? "could not open this link";
      if (r.status === 404) { setPhase("notfound"); setError(message); return; }
      // 401 (or anything else): fall back to the password form. On the
      // silent mount probe there's nothing wrong to report yet — a wrong
      // *guess* only exists once the visitor actually submits one.
      setPhase("form");
      if (!isProbe) setError(message);
    } catch (e) {
      setPhase("form");
      if (!isProbe) setError(e instanceof Error ? e.message : "could not open this link");
    } finally {
      if (!isProbe) setBusy(false);
    }
  };

  useEffect(() => {
    void attempt("", true);
    // Runs once per token; attempt is re-created each render but that's not
    // a dependency we want re-triggering the probe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void attempt(password, false);
  };

  if (phase === "checking") return null;
  if (phase === "unlocked") return <ShareView token={token} />;

  if (phase === "notfound") {
    return (
      <main className="share-page">
        <div className="share-card">
          <p role="alert">{error}</p>
        </div>
      </main>
    );
  }

  return (
    <main className="share-page">
      <form className="share-card rise" onSubmit={submit}>
        <h1>This link is password protected</h1>
        <label htmlFor="pw">Password</label>
        <input
          id="pw" type="password" autoComplete="off" value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p role="alert" className="field-error">{error}</p>}
        <button type="submit" disabled={busy}>{busy ? "Opening…" : "Unlock"}</button>
      </form>
    </main>
  );
}
