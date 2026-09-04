import { type FormEvent, useState } from "react";
import {
  useAddGroupMember, useAdminUsers, useCreateGroup, useGroupMembers, useGroups, useMe, useRemoveGroupMember,
} from "../../api/queries";
import EmptyState from "../../components/EmptyState";

// Members are chosen from GET /api/admin/users (admin-only, same as this
// whole page) — only fetched once a group is actually expanded, mirroring
// useSpaceFolders' enabled-on-demand pattern elsewhere in this app.
function GroupMembers({ groupId }: { groupId: string }) {
  const members = useGroupMembers(groupId);
  const users = useAdminUsers();
  const addMember = useAddGroupMember(groupId);
  const removeMember = useRemoveGroupMember(groupId);
  const [userId, setUserId] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!userId) return;
    addMember.mutate(userId, { onSuccess: () => setUserId("") });
  };

  // isPending settles to false on error too, so isError is checked
  // explicitly before any empty-list branch — otherwise a 500 here reads as
  // "no members" instead of a fault.
  let list;
  if (members.isPending) {
    list = <p className="modal-hint">Loading members…</p>;
  } else if (members.isError) {
    list = (
      <div className="auth-retry" role="alert">
        <p>Could not load members.</p>
        <button type="button" onClick={() => members.refetch()}>Retry</button>
      </div>
    );
  } else if (members.data.length === 0) {
    list = <p className="modal-hint">No members yet.</p>;
  } else {
    list = (
      <ul className="admin-list">
        {members.data.map((m) => (
          <li key={m.id} className="admin-row">
            <span>{m.name}</span>
            <span className="mono-label">{m.email}</span>
            <button type="button" onClick={() => removeMember.mutate(m.id)}>Remove</button>
          </li>
        ))}
      </ul>
    );
  }

  const memberIds = new Set((members.data ?? []).map((m) => m.id));
  const candidates = (users.data ?? []).filter((u) => !memberIds.has(u.id));

  return (
    <div className="group-members">
      {list}
      {removeMember.isError && (
        <p role="alert" className="field-error">{(removeMember.error as Error).message}</p>
      )}

      {users.isError ? (
        <div className="auth-retry" role="alert">
          <p>Could not load users.</p>
          <button type="button" onClick={() => users.refetch()}>Retry</button>
        </div>
      ) : (
        <form className="admin-form admin-form-inline" onSubmit={submit}>
          <label htmlFor={`add-member-${groupId}`}>Add a member</label>
          <select
            id={`add-member-${groupId}`} value={userId} onChange={(e) => setUserId(e.target.value)}
          >
            <option value="">Select a user…</option>
            {candidates.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <button type="submit" disabled={!userId || addMember.isPending}>Add</button>
        </form>
      )}
      {addMember.isError && <p role="alert" className="field-error">{(addMember.error as Error).message}</p>}
    </div>
  );
}

export default function Groups() {
  const { data: me } = useMe();
  const groups = useGroups();
  const create = useCreateGroup();
  const [name, setName] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

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
            <li key={g.id}>
              <div className="admin-row">
                <span>{g.name}</span>
                <span className="mono-label">{g.member_count} member{g.member_count === 1 ? "" : "s"}</span>
                <button type="button" onClick={() => setExpanded(expanded === g.id ? null : g.id)}>
                  {expanded === g.id ? "Hide members" : "Manage members"}
                </button>
              </div>
              {expanded === g.id && <GroupMembers groupId={g.id} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
