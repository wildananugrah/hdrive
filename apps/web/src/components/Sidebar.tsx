import { useState } from "react";
import { NavLink } from "react-router-dom";
import type { User } from "../api/types";
import CreateSpaceModal from "./CreateSpaceModal";
import SpaceSwitcher from "./SpaceSwitcher";

export default function Sidebar({ me, spaceId }: { me: User; spaceId?: string }) {
  const [showCreate, setShowCreate] = useState(false);
  const item = (to: string, label: string, end = false) => (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) => `nav-item${isActive ? " is-active" : ""}`}
    >
      {label}
    </NavLink>
  );

  return (
    <nav className="sidebar">
      <div className="sidebar-brand">hdrive</div>
      <div className="space-switcher-row">
        <SpaceSwitcher />
        <button type="button" className="new-space-btn" onClick={() => setShowCreate(true)}>
          New space
        </button>
      </div>
      {showCreate && <CreateSpaceModal onClose={() => setShowCreate(false)} />}

      {/* No spaceId means the user has no space to scope these links to
          (e.g. the empty-spaces state, or the id hasn't loaded yet) —
          render nothing here rather than emit hrefs like "/space/". */}
      {spaceId && (
        <div className="nav-group">
          {item(`/space/${spaceId}`, "My files", true)}
          {item(`/space/${spaceId}?vis=shared`, "Shared")}
          {item(`/space/${spaceId}?sort=modified`, "Recent")}
          {item(`/space/${spaceId}/trash`, "Trash")}
        </div>
      )}

      {/* Backend enforces requireAdmin on every /admin route regardless, but
          the nav must not offer a destination it cannot deliver. */}
      {me.is_admin && (
        <>
          <div className="mono-label nav-heading">Admin</div>
          <div className="nav-group">
            {item("/admin/backends", "Storage backends")}
            {item("/admin/users", "Users")}
            {item("/admin/groups", "Groups")}
          </div>
        </>
      )}

      <div className="nav-group nav-group-bottom">
        {item("/settings", "Settings")}
      </div>
    </nav>
  );
}
