import { useAdminUsers, useMe, useSetAdmin } from "../../api/queries";
import { isConflict } from "../../api/errors";
import Avatar from "../../components/Avatar";
import EmptyState from "../../components/EmptyState";

export default function Users() {
  const { data: me } = useMe();
  const users = useAdminUsers();
  const setAdmin = useSetAdmin();

  if (me && !me.is_admin) {
    return <EmptyState title="Forbidden" hint="You do not have access to this page." />;
  }

  // The mutation's own `variables` names which row is mid-flight/errored —
  // no extra state needed to track that separately.
  const errorRowId = setAdmin.isError ? (setAdmin.variables as { id: string } | undefined)?.id : undefined;

  return (
    <div className="admin-page">
      <h1>Users</h1>
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
