import { type FormEvent, useState } from "react";
import { useBackends, useCreateBackend, useMe } from "../../api/queries";
import EmptyState from "../../components/EmptyState";
import BackendRow from "./BackendRow";

// Credentials are never returned by the API (listBackends omits config), so
// this form is the only place they ever exist in the UI — cleared after a
// successful create and never re-populated from server data.
export default function Backends() {
  const { data: me } = useMe();
  const backends = useBackends();
  const create = useCreateBackend();

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [bucket, setBucket] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [virtualHostedStyle, setVirtualHostedStyle] = useState(false);
  const [makeWriteTarget, setMakeWriteTarget] = useState(false);

  // The backend enforces requireAdmin regardless; the sidebar hides this link
  // from non-admins, but a forced URL must still render something sane
  // rather than a broken screen — this is that guard.
  if (me && !me.is_admin) {
    return <EmptyState title="Forbidden" hint="You do not have access to this page." />;
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(
      { name, config: { endpoint, bucket, accessKeyId, secretAccessKey, virtualHostedStyle }, makeWriteTarget },
      {
        onSuccess: () => {
          setName(""); setEndpoint(""); setBucket(""); setAccessKeyId(""); setSecretAccessKey("");
          setVirtualHostedStyle(false); setMakeWriteTarget(false);
          setShowForm(false);
        },
      },
    );
  };

  return (
    <div className="admin-page">
      <div className="admin-header">
        <h1>Storage backends</h1>
        <button type="button" onClick={() => setShowForm((s) => !s)}>
          {showForm ? "Cancel" : "Add backend"}
        </button>
      </div>

      {showForm && (
        <form className="admin-form" onSubmit={submit}>
          <label htmlFor="be-name">Name</label>
          <input id="be-name" value={name} onChange={(e) => setName(e.target.value)} required />

          <label htmlFor="be-endpoint">Endpoint</label>
          <input id="be-endpoint" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} required />

          <label htmlFor="be-bucket">Bucket</label>
          <input id="be-bucket" value={bucket} onChange={(e) => setBucket(e.target.value)} required />

          <label htmlFor="be-access-key">Access key ID</label>
          <input id="be-access-key" value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} required />

          <label htmlFor="be-secret-key">Secret access key</label>
          <input
            id="be-secret-key" type="password" autoComplete="off"
            value={secretAccessKey} onChange={(e) => setSecretAccessKey(e.target.value)} required
          />

          <label className="admin-checkbox">
            <input
              type="checkbox" checked={virtualHostedStyle}
              onChange={(e) => setVirtualHostedStyle(e.target.checked)}
            />
            Virtual-hosted-style addressing
          </label>

          <label className="admin-checkbox">
            <input type="checkbox" checked={makeWriteTarget} onChange={(e) => setMakeWriteTarget(e.target.checked)} />
            Make this the write target
          </label>

          {create.isError && <p role="alert" className="field-error">{(create.error as Error).message}</p>}

          <button type="submit" disabled={create.isPending}>
            {create.isPending ? "Adding…" : "Add backend"}
          </button>
        </form>
      )}

      {/* isPending settles to false on error too — isError is a distinct
          branch, never collapsed into "no backends yet". */}
      {backends.isPending ? (
        <p className="modal-hint">Loading backends…</p>
      ) : backends.isError ? (
        <div className="auth-retry" role="alert">
          <p>Could not load backends.</p>
          <button type="button" onClick={() => backends.refetch()}>Retry</button>
        </div>
      ) : backends.data.length === 0 ? (
        <EmptyState title="No storage backends" hint="Add one to start storing files." />
      ) : (
        <div className="admin-list">
          {backends.data.map((b) => <BackendRow key={b.id} backend={b} />)}
        </div>
      )}
    </div>
  );
}
