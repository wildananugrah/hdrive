import { type FormEvent, useState } from "react";
import { useGrantItem, useGrants, useGroups, useRevokeGrant, useSpaceMembers } from "../api/queries";
import { isForbidden } from "../api/errors";
import { EDITOR, OWNER, VIEWER, type Item, type Role } from "../api/types";
import Modal from "./Modal";

const ROLE_NAME: Record<Role, "viewer" | "editor" | "owner"> = {
  [VIEWER]: "viewer", [EDITOR]: "editor", [OWNER]: "owner",
};

type Tab = "people" | "groups";

export default function PermissionsModal({ item, onClose }: { item: Item; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("people");
  const [addId, setAddId] = useState("");
  const [addRole, setAddRole] = useState<"viewer" | "editor" | "owner">("viewer");

  // Managing grants requires OWNER on the item, so this list itself can 403 —
  // isError below is not just for network failures.
  const grants = useGrants(item.id);
  const members = useSpaceMembers(item.space_id);
  // The Groups tab — the half the mockup never had — is populated from
  // useGroups(), which is admin-gated server-side even for an OWNER of this
  // item, so a non-admin owner can hit isError here purely from that.
  const groups = useGroups();
  const grant = useGrantItem(item.id);
  const revoke = useRevokeGrant(item.id);

  const switchTab = (t: Tab) => { setTab(t); setAddId(""); setAddRole("viewer"); grant.reset(); };

  const peopleGrants = (grants.data ?? []).filter((g) => g.subject_type === "user");
  const groupGrants = (grants.data ?? []).filter((g) => g.subject_type === "group");
  const peopleCandidates = (members.data ?? [])
    .filter((m) => m.subject_type === "user")
    .map((m) => ({ id: m.subject_id, name: m.name }));
  const groupCandidates = (groups.data ?? []).map((g) => ({ id: g.id, name: g.name }));

  const grantsForTab = tab === "people" ? peopleGrants : groupGrants;
  const candidates = tab === "people" ? peopleCandidates : groupCandidates;
  const candidatesQuery = tab === "people" ? members : groups;
  const nameFor = (id: string) =>
    (tab === "people" ? peopleCandidates : groupCandidates).find((c) => c.id === id)?.name ?? id;

  const submitAdd = (e: FormEvent) => {
    e.preventDefault();
    if (!addId) return;
    grant.mutate(
      { subject: { type: tab === "people" ? "user" : "group", id: addId }, role: addRole },
      { onSuccess: () => setAddId("") },
    );
  };

  return (
    <Modal title={`Manage access to "${item.name}"`} onClose={onClose}>
      <div className="perm-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "people"} onClick={() => switchTab("people")}>
          People
        </button>
        <button type="button" role="tab" aria-selected={tab === "groups"} onClick={() => switchTab("groups")}>
          Groups
        </button>
      </div>

      {/* isPending settles to false on error too — isError is checked
          explicitly so a 403/500 never renders as "nobody has access". */}
      {grants.isPending ? (
        <p className="modal-hint">Loading access…</p>
      ) : grants.isError ? (
        <div className="auth-retry" role="alert">
          <p>Could not load access.</p>
          <button type="button" onClick={() => grants.refetch()}>Retry</button>
        </div>
      ) : (
        <>
          <ul className="perm-list">
            {grantsForTab.length === 0 && (
              <li className="modal-hint">
                No {tab === "people" ? "people have" : "groups have"} direct access.
              </li>
            )}
            {grantsForTab.map((g) => (
              <li key={g.subject_id} className="perm-row">
                <span>{nameFor(g.subject_id)}</span>
                <select
                  aria-label={`Role for ${nameFor(g.subject_id)}`}
                  value={ROLE_NAME[g.role]}
                  onChange={(e) =>
                    grant.mutate({
                      subject: { type: tab === "people" ? "user" : "group", id: g.subject_id },
                      role: e.target.value as "viewer" | "editor" | "owner",
                    })
                  }
                >
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                  <option value="owner">Owner</option>
                </select>
                <button
                  type="button"
                  onClick={() => revoke.mutate({ type: tab === "people" ? "user" : "group", id: g.subject_id })}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>

          {candidatesQuery.isError ? (
            <div className="auth-retry" role="alert">
              <p>
                {tab === "groups" && isForbidden(candidatesQuery.error)
                  ? "Only administrators can grant access to groups."
                  : `Could not load ${tab === "people" ? "space members" : "groups"}.`}
              </p>
              <button type="button" onClick={() => candidatesQuery.refetch()}>Retry</button>
            </div>
          ) : (
            <form className="perm-add" onSubmit={submitAdd}>
              <select
                aria-label={tab === "people" ? "Person to add" : "Group to add"}
                value={addId}
                onChange={(e) => setAddId(e.target.value)}
              >
                <option value="">{tab === "people" ? "Select a person…" : "Select a group…"}</option>
                {candidates
                  .filter((c) => !grantsForTab.some((g) => g.subject_id === c.id))
                  .map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <select aria-label="Role to add" value={addRole} onChange={(e) => setAddRole(e.target.value as any)}>
                <option value="viewer">Viewer</option>
                <option value="editor">Editor</option>
                <option value="owner">Owner</option>
              </select>
              <button type="submit" disabled={!addId || grant.isPending}>Add</button>
            </form>
          )}
        </>
      )}

      {grant.isError && <p role="alert" className="field-error">{(grant.error as Error).message}</p>}
      {revoke.isError && <p role="alert" className="field-error">{(revoke.error as Error).message}</p>}
    </Modal>
  );
}
