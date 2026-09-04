import { type FormEvent, useState } from "react";
import { useParams } from "react-router-dom";
import {
  useAddSpaceMember, useGroups, useMe, useRemoveSpaceMember, useSpaceMembers, useUpdateSpaceMemberRole,
} from "../api/queries";
import { isForbidden, isNotFound } from "../api/errors";
import { EDITOR, OWNER, VIEWER, type Role, type Subject } from "../api/types";
import Avatar from "../components/Avatar";
import EmptyState from "../components/EmptyState";
import Modal from "../components/Modal";

const ROLE_NAME: Record<Role, "viewer" | "editor" | "owner"> = {
  [VIEWER]: "viewer", [EDITOR]: "editor", [OWNER]: "owner",
};

// Removing your own OWNER role — by demoting or removing yourself — locks you
// out: the API refuses your next management call and this screen becomes
// unreachable. That needs an explicit confirmation naming the consequence,
// not a one-click select/button, so it's tracked as a pending action here
// rather than applied immediately.
type PendingSelfAction = { subject: Subject; role?: "viewer" | "editor" | "owner" };

// A generic "remove this member" confirmation — deliberately a separate piece
// of state from PendingSelfAction above: that one warns about a worse and
// different consequence (locking yourself out), and both its paths are
// already covered by tests that must keep working unchanged.
type PendingRemove = { subject: Subject; name: string };

export default function SpaceMembers() {
  const { spaceId = "" } = useParams();
  const { data: me } = useMe();
  const members = useSpaceMembers(spaceId);
  const groups = useGroups(Boolean(me?.is_admin));
  const addMember = useAddSpaceMember(spaceId);
  const addGroup = useAddSpaceMember(spaceId);
  const updateRole = useUpdateSpaceMemberRole(spaceId);
  const removeMember = useRemoveSpaceMember(spaceId);

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"viewer" | "editor" | "owner">("viewer");
  const [groupId, setGroupId] = useState("");
  const [groupRole, setGroupRole] = useState<"viewer" | "editor" | "owner">("viewer");
  const [pendingSelf, setPendingSelf] = useState<PendingSelfAction | null>(null);
  const [pendingRemove, setPendingRemove] = useState<PendingRemove | null>(null);

  const submitEmail = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) return;
    addMember.mutate({ email: trimmed, role }, { onSuccess: () => setEmail("") });
  };

  const submitGroup = (e: FormEvent) => {
    e.preventDefault();
    if (!groupId) return;
    addGroup.mutate(
      { subject: { type: "group", id: groupId }, role: groupRole },
      { onSuccess: () => setGroupId("") },
    );
  };

  const changeRole = (subject: Subject, newRole: "viewer" | "editor" | "owner", isSelfOwner: boolean) => {
    if (isSelfOwner && newRole !== "owner") { setPendingSelf({ subject, role: newRole }); return; }
    updateRole.mutate({ subject, role: newRole });
  };

  // Every removal needs confirmation, not just self-removal (Spec §5.3) — a
  // mis-clicked Remove in a large space must not revoke someone's access on
  // the first click. Self-removal keeps its own, distinct modal above because
  // it warns about a worse consequence (losing your own access).
  const remove = (subject: Subject, isSelfOwner: boolean, name: string) => {
    if (isSelfOwner) { setPendingSelf({ subject }); return; }
    setPendingRemove({ subject, name });
  };

  const confirmPendingSelf = () => {
    if (!pendingSelf) return;
    if (pendingSelf.role) updateRole.mutate({ subject: pendingSelf.subject, role: pendingSelf.role });
    else removeMember.mutate(pendingSelf.subject);
    setPendingSelf(null);
  };

  const confirmPendingRemove = () => {
    if (!pendingRemove) return;
    removeMember.mutate(pendingRemove.subject);
    setPendingRemove(null);
  };

  const ownershipRequired = (
    <EmptyState
      title="Ownership required"
      hint="You need to be an owner of this space to manage its members."
    />
  );

  // FIX 3: the client cannot see which groups the caller belongs to (useMe()
  // carries no group memberships), while the API's effective role is the max
  // across the caller's own row AND every group they're in (perm.ts
  // effectiveRole). Pre-deriving "am I owner" from members.data alone would
  // therefore lock out a group-granted owner even though the server would
  // accept their management calls. So: don't pre-compute ownership at all —
  // render the management UI once the (VIEWER-gated) members list has loaded,
  // and let a 403/404 from an actual management call be the "not an owner"
  // signal instead. The one exception is "add by email": its 404 means
  // "no user with that email" (thrown before the ownership check server-side)
  // and must stay a plain inline error, never be read as ownership-related.
  const managementForbidden =
    (addMember.isError && isForbidden(addMember.error)) ||
    (addGroup.isError && (isForbidden(addGroup.error) || isNotFound(addGroup.error))) ||
    (updateRole.isError && (isForbidden(updateRole.error) || isNotFound(updateRole.error))) ||
    (removeMember.isError && (isForbidden(removeMember.error) || isNotFound(removeMember.error)));

  let body: React.ReactNode;
  // isPending settles to false on error too, so isError is checked explicitly
  // before any empty/data branch — otherwise a 500 here would render as an
  // empty member list instead of a fault.
  if (members.isPending) {
    body = <p className="modal-hint">Loading members…</p>;
  } else if (members.isError) {
    // The API returns 404 for "not a member" as well as "space doesn't
    // exist", deliberately (see isNotFound) — never say "forbidden" for
    // that case. Both a 403 and a 404 here mean the same thing to this
    // screen: the caller can't manage this space's members.
    body = isForbidden(members.error) || isNotFound(members.error) ? ownershipRequired : (
      <div className="auth-retry" role="alert">
        <EmptyState title="Something went wrong" hint={(members.error as Error).message} />
        <button type="button" onClick={() => members.refetch()}>Retry</button>
      </div>
    );
  } else if (managementForbidden) {
    body = ownershipRequired;
  } else {
    body = (
        <>
          <ul className="admin-list">
            {members.data.map((m) => {
              // Only the row that IS this user's own OWNER grant risks a
              // self-lockout — a viewer/editor row for "me" has nothing to warn
              // about, and (post-FIX-3) this UI is shown before ownership is
              // confirmed, so this can no longer assume "me" implies OWNER.
              const isSelfOwner = m.subject_type === "user" && m.subject_id === me?.id && m.role === OWNER;
              const subject: Subject = { type: m.subject_type, id: m.subject_id };
              return (
                <li key={`${m.subject_type}:${m.subject_id}`} className="admin-row">
                  <Avatar name={m.name} />
                  <div>
                    <p>
                      {m.name}
                      {/* Groups are marked distinctly — granting to an empty group does nothing visible. */}
                      <span className="pill-muted">{m.subject_type === "group" ? "Group" : "Person"}</span>
                    </p>
                    {m.email && <p className="mono-label">{m.email}</p>}
                  </div>
                  <select
                    aria-label={`Role for ${m.name}`}
                    value={ROLE_NAME[m.role]}
                    onChange={(e) => changeRole(subject, e.target.value as "viewer" | "editor" | "owner", isSelfOwner)}
                  >
                    <option value="viewer">Viewer</option>
                    <option value="editor">Editor</option>
                    <option value="owner">Owner</option>
                  </select>
                  <button
                    type="button" aria-label={`Remove ${m.name}`}
                    onClick={() => remove(subject, isSelfOwner, m.name)}
                  >
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>

          {updateRole.isError && <p role="alert" className="field-error">{(updateRole.error as Error).message}</p>}
          {removeMember.isError && <p role="alert" className="field-error">{(removeMember.error as Error).message}</p>}

          <form className="admin-form admin-form-inline" onSubmit={submitEmail}>
            <label htmlFor="member-email">Add by email</label>
            <input
              id="member-email" type="email" value={email}
              onChange={(e) => setEmail(e.target.value)} required
            />
            <select aria-label="Role to add" value={role} onChange={(e) => setRole(e.target.value as any)}>
              <option value="viewer">Viewer</option>
              <option value="editor">Editor</option>
              <option value="owner">Owner</option>
            </select>
            <button type="submit" disabled={addMember.isPending}>Add</button>
          </form>
          {addMember.isError && (
            // Server body for the specific case this screen must get right:
            // an unknown email 404s with {"error":"no user with that email"} —
            // rendered verbatim, not replaced with a generic message.
            <p role="alert" className="field-error">{(addMember.error as Error).message}</p>
          )}

          {/* GET /api/groups is admin-only server-side, so a non-admin owner
              has no way to list groups to grant — offer this only to admins.
              isError is checked explicitly here too: without it, a failed
              groups fetch silently renders as an empty "Select a group…"
              list instead of a fault. */}
          {me?.is_admin && (
            groups.isError ? (
              <div className="auth-retry" role="alert">
                <p>Could not load groups.</p>
                <button type="button" onClick={() => groups.refetch()}>Retry</button>
              </div>
            ) : (
              <form className="admin-form admin-form-inline" onSubmit={submitGroup}>
                <label htmlFor="member-group">Add a group</label>
                <select
                  id="member-group" value={groupId} onChange={(e) => setGroupId(e.target.value)}
                >
                  <option value="">Select a group…</option>
                  {(groups.data ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
                <select aria-label="Group role to add" value={groupRole} onChange={(e) => setGroupRole(e.target.value as any)}>
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                  <option value="owner">Owner</option>
                </select>
                <button type="submit" disabled={!groupId || addGroup.isPending}>Add</button>
              </form>
            )
          )}
          {addGroup.isError && <p role="alert" className="field-error">{(addGroup.error as Error).message}</p>}
        </>
    );
  }

  return (
    <div className="admin-page">
      <h1>Members</h1>
      {body}

      {pendingSelf && (
        <Modal title="This removes your own access" onClose={() => setPendingSelf(null)}>
          <p className="modal-hint">
            {pendingSelf.role
              ? `Changing your own role to ${pendingSelf.role} gives up your OWNER access — you will lose the ability to manage this space.`
              : "Removing yourself from this space locks you out of managing it."}
          </p>
          <button type="button" onClick={() => setPendingSelf(null)}>Cancel</button>
          <button type="button" onClick={confirmPendingSelf}>
            {pendingSelf.role ? "Change my role" : "Remove me"}
          </button>
        </Modal>
      )}

      {pendingRemove && (
        <Modal title="Remove member" onClose={() => setPendingRemove(null)}>
          <p className="modal-hint">{`Remove ${pendingRemove.name} from this space?`}</p>
          <button type="button" onClick={() => setPendingRemove(null)}>Cancel</button>
          <button type="button" onClick={confirmPendingRemove}>Remove</button>
        </Modal>
      )}
    </div>
  );
}
