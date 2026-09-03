import { type FormEvent, useState } from "react";
import { useParams } from "react-router-dom";
import { API_BASE } from "../../api/client";
import { ApiError } from "../../api/errors";
import ShareView from "./View";
import "../../styles/share.css";

// Public page, no app chrome: a share recipient is not signed in, so this
// deliberately renders no Sidebar/Header — see App.tsx, this route sits
// outside RequireAuth.
export default function Unlock() {
  const { token = "" } = useParams();
  const [password, setPassword] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`${API_BASE}/s/${token}/unlock`, {
        method: "POST",
        // The unlock cookie is short-lived and path-scoped; without
        // credentials: "include" it's dropped and GET /s/:token 401s right
        // after a "successful" unlock.
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!r.ok) {
        const payload = await r.json().catch(() => ({}));
        // Show exactly what the API said. unknown/expired/revoked/trashed all
        // return the SAME 404 on purpose; inventing a more specific message
        // here ("this link expired", "this link was revoked") would leak a
        // distinction the API deliberately refuses to disclose.
        throw new ApiError(r.status, payload.error ?? "could not open this link");
      }
      setUnlocked(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not open this link");
    } finally {
      setBusy(false);
    }
  };

  if (unlocked) return <ShareView token={token} />;

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
