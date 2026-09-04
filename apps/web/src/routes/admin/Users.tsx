import { type FormEvent, useState } from "react";
import { useAdminUsers, useCreateUser, useMe, useSetAdmin } from "../../api/queries";
import { isConflict } from "../../api/errors";
import Avatar from "../../components/Avatar";
import EmptyState from "../../components/EmptyState";

// Mirrors register()'s server-side checks exactly (apps/api/src/auth.ts) so an
// invalid submission never makes a round trip. The server enforces these
// regardless — this is a convenience, not the security boundary.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export default function Users() {
  const { data: me } = useMe();
  const users = useAdminUsers();
  const setAdmin = useSetAdmin();
  const createUser = useCreateUser();

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // There is no email delivery in this system — the admin hands the password
  // to the person out-of-band. The server never returns it again after this
  // response, so this is the ONLY place it's ever held, and only until the
  // panel is dismissed.
  const [createdPassword, setCreatedPassword] = useState<string | null>(null);
  // Only meaningful alongside createdPassword — true when register() succeeded
  // but the follow-up admin PATCH failed, so the account exists unpromoted.
  const [promoteFailed, setPromoteFailed] = useState(false);

  if (me && !me.is_admin) {
    return <EmptyState title="Forbidden" hint="You do not have access to this page." />;
  }

  // The mutation's own `variables` names which row is mid-flight/errored —
  // no extra state needed to track that separately.
  const errorRowId = setAdmin.isError ? (setAdmin.variables as { id: string } | undefined)?.id : undefined;

  const toggleForm = () => {
    setShowForm((s) => !s);
    setName(""); setEmail(""); setPassword(""); setIsAdmin(false);
    setFormError(null); setCreatedPassword(null); setPromoteFailed(false);
    createUser.reset();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const trimmedName = name.trim();
    const normalizedEmail = email.trim().toLowerCase();
    if (!trimmedName) { setFormError("Name is required."); return; }
    if (!EMAIL_RE.test(normalizedEmail)) { setFormError("Enter a valid email address."); return; }
    if (password.length < 8) { setFormError("Password must be at least 8 characters."); return; }

    const enteredPassword = password;
    createUser.mutate(
      { name: trimmedName, email: normalizedEmail, password, isAdmin },
      {
        onSuccess: (data) => {
          setName(""); setEmail(""); setPassword(""); setIsAdmin(false);
          setCreatedPassword(enteredPassword);
          setPromoteFailed(data.promoteFailed);
        },
      },
    );
  };

  return (
    <div className="admin-page">
      <div className="admin-header">
        <h1>Users</h1>
        <button type="button" onClick={toggleForm}>{showForm ? "Cancel" : "Add user"}</button>
      </div>

      {showForm && (
        createdPassword ? (
          <div className="share-created">
            <p className="mono-label">
              Copy this password now — it is shown only once and cannot be recovered. Hdrive does not
              email it; give it to the person directly.
            </p>
            {promoteFailed && (
              <p role="alert" className="field-error">
                The account was created but could not be made an administrator. Promote them from the
                list below.
              </p>
            )}
            <div className="share-created-row">
              <input readOnly aria-label="Generated password" value={createdPassword} />
              <button type="button" onClick={() => navigator.clipboard.writeText(createdPassword)}>
                Copy
              </button>
            </div>
            <button type="button" onClick={toggleForm}>Done</button>
          </div>
        ) : (
          <form className="admin-form" onSubmit={submit}>
            <label htmlFor="user-name">Name</label>
            <input id="user-name" value={name} onChange={(e) => setName(e.target.value)} required />

            <label htmlFor="user-email">Email</label>
            <input
              id="user-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required
            />

            <label htmlFor="user-password">Password</label>
            <input
              id="user-password" type="password" autoComplete="new-password"
              value={password} onChange={(e) => setPassword(e.target.value)} required
            />

            <label className="admin-checkbox">
              <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />
              Administrator
            </label>

            {(formError || createUser.isError) && (
              <p role="alert" className="field-error">
                {formError ??
                  // The API's 409 body is opaque ({"error":"conflict"}) — the
                  // actionable copy naming the duplicate email is written
                  // here, not echoed from the server.
                  (isConflict(createUser.error)
                    ? `${email.trim().toLowerCase()} is already registered.`
                    : (createUser.error as Error).message)}
              </p>
            )}

            <button type="submit" disabled={createUser.isPending}>
              {createUser.isPending ? "Creating…" : "Create user"}
            </button>
          </form>
        )
      )}

      {users.isPending ? (
        <p className="modal-hint">Loading users…</p>
      ) : users.isError ? (
        <div className="auth-retry" role="alert">
          <p>Could not load users.</p>
          <button type="button" onClick={() => users.refetch()}>Retry</button>
        </div>
      ) : users.data.length === 0 ? (
        <EmptyState title="No users" />
      ) : (
        <ul className="admin-list">
          {users.data.map((u) => (
            <li key={u.id} className="admin-row">
              <Avatar name={u.name} />
              <div>
                <p>{u.name}</p>
                <p className="mono-label">{u.email}</p>
              </div>
              <span className="pill-muted">{u.is_admin ? "Admin" : "Member"}</span>
              <button
                type="button"
                onClick={() => setAdmin.mutate({ id: u.id, is_admin: !u.is_admin })}
                disabled={setAdmin.isPending}
              >
                {u.is_admin ? "Demote" : "Promote"}
              </button>
              {errorRowId === u.id && (
                // The API 409s a demote that would leave zero admins — say
                // exactly that, not a generic "request failed".
                <p role="alert" className="field-error">
                  {isConflict(setAdmin.error)
                    ? "Cannot remove the last admin — promote someone else first."
                    : (setAdmin.error as Error).message}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
