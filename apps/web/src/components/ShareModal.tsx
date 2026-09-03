import { type FormEvent, useState } from "react";
import { useCreateShare, useRevokeShare, useShares } from "../api/queries";
import type { Item } from "../api/types";
import Modal from "./Modal";

const linkUrl = (token: string) => `${location.origin}/share/${token}`;

export default function ShareModal({ item, onClose }: { item: Item; onClose: () => void }) {
  // isPending settles to false on error too (React Query v5), so every read
  // below branches on isError explicitly — never collapse "error" into
  // "empty list".
  const shares = useShares(item.id);
  const create = useCreateShare(item.id);
  const revoke = useRevokeShare(item.id);

  const [mode, setMode] = useState<"view" | "download">("view");
  const [password, setPassword] = useState("");
  const [expiryDays, setExpiryDays] = useState("7");
  const [neverExpires, setNeverExpires] = useState(false);
  // The raw token only ever exists in this mutation's response — listShares
  // (shares.data) cannot return one, so this is the ONLY place a token is
  // ever held in the UI, and only until the modal is closed or another link
  // is created.
  const [createdToken, setCreatedToken] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(
      { mode, password: password || undefined, expiresInDays: neverExpires ? null : Number(expiryDays) },
      { onSuccess: (link) => setCreatedToken(link.token) },
    );
  };

  return (
    <Modal title={`Share "${item.name}"`} onClose={onClose}>
      {createdToken ? (
        <div className="share-created">
          {/* Not decoration: the API stores only a SHA-256 of the token, so a
              link the user fails to copy now is unrecoverable and must be
              re-created from scratch. */}
          <p className="mono-label">Copy this link now — it is shown only once and cannot be retrieved again.</p>
          <div className="share-created-row">
            <input readOnly aria-label="Share link" value={linkUrl(createdToken)} />
            <button type="button" onClick={() => navigator.clipboard.writeText(linkUrl(createdToken))}>
              Copy
            </button>
          </div>
          <button type="button" onClick={() => { create.reset(); setCreatedToken(null); }}>
            Create another link
          </button>
        </div>
      ) : (
        <form className="share-form" onSubmit={submit}>
          <label htmlFor="share-mode">Mode</label>
          <select id="share-mode" value={mode} onChange={(e) => setMode(e.target.value as "view" | "download")}>
            <option value="view">View only</option>
            <option value="download">Download</option>
          </select>

          <label htmlFor="share-password">Password (optional)</label>
          <input
            id="share-password" type="password" autoComplete="off" value={password}
            onChange={(e) => setPassword(e.target.value)}
          />

          <label htmlFor="share-expiry">Expires</label>
          <select
            id="share-expiry" value={expiryDays} disabled={neverExpires}
            onChange={(e) => setExpiryDays(e.target.value)}
          >
            <option value="1">1 day</option>
            <option value="7">7 days</option>
            <option value="30">30 days</option>
          </select>

          {/* "Never" is an explicit opt-in checkbox rather than just another
              option in the select above — expiresInDays: null is allowed, but
              it's a real choice (the link stays live until someone revokes
              it), so the easy default must stay 7 days. */}
          <label className="share-never">
            <input type="checkbox" checked={neverExpires} onChange={(e) => setNeverExpires(e.target.checked)} />
            Never expire — the link stays live until revoked
          </label>

          {create.isError && <p role="alert" className="field-error">{(create.error as Error).message}</p>}

          <button type="submit" disabled={create.isPending}>
            {create.isPending ? "Creating…" : "Create link"}
          </button>
        </form>
      )}

      <div className="share-existing">
        <h3 className="mono-label">Existing links</h3>
        {shares.isPending ? (
          <p className="modal-hint">Loading links…</p>
        ) : shares.isError ? (
          <div className="auth-retry" role="alert">
            <p>Could not load links.</p>
            <button type="button" onClick={() => shares.refetch()}>Retry</button>
          </div>
        ) : shares.data.length === 0 ? (
          <p className="modal-hint">No links yet.</p>
        ) : (
          <ul className="share-list">
            {shares.data.map((link) => (
              <li key={link.id} className="share-list-row">
                <span>{link.mode === "view" ? "View only" : "Download"}</span>
                <span>{link.has_password ? "Password protected" : "No password"}</span>
                <span>
                  {link.revoked_at
                    ? "Revoked"
                    : link.expires_at
                    ? `Expires ${new Date(link.expires_at).toLocaleDateString()}`
                    : "Never expires"}
                </span>
                {/* Never a token/URL here — listShares cannot return one. */}
                {!link.revoked_at && (
                  <button type="button" onClick={() => revoke.mutate(link.id)} disabled={revoke.isPending}>
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
