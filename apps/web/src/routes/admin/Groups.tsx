import { type FormEvent, useState } from "react";
import { useCreateGroup, useGroups, useMe } from "../../api/queries";
import EmptyState from "../../components/EmptyState";

export default function Groups() {
  const { data: me } = useMe();
  const groups = useGroups();
  const create = useCreateGroup();
  const [name, setName] = useState("");

  if (me && !me.is_admin) {
    return <EmptyState title="Forbidden" hint="You do not have access to this page." />;
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate(name.trim(), { onSuccess: () => setName("") });
  };

  return (
    <div className="admin-page">
      <h1>Groups</h1>

      <form className="admin-form admin-form-inline" onSubmit={submit}>
        <label htmlFor="group-name">New group</label>
        <input id="group-name" value={name} onChange={(e) => setName(e.target.value)} required />
        <button type="submit" disabled={create.isPending}>Create</button>
      </form>
      {create.isError && <p role="alert" className="field-error">{(create.error as Error).message}</p>}

      {groups.isPending ? (
        <p className="modal-hint">Loading groups…</p>
      ) : groups.isError ? (
        <div className="auth-retry" role="alert">
          <p>Could not load groups.</p>
          <button type="button" onClick={() => groups.refetch()}>Retry</button>
        </div>
      ) : groups.data.length === 0 ? (
        <EmptyState title="No groups yet" hint="Create one to start granting shared access." />
      ) : (
        <ul className="admin-list">
          {groups.data.map((g) => (
            <li key={g.id} className="admin-row">
              <span>{g.name}</span>
              <span className="mono-label">{g.member_count} member{g.member_count === 1 ? "" : "s"}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
