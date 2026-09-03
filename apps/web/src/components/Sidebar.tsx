import { NavLink } from "react-router-dom";
import type { User } from "../api/types";
import SpaceSwitcher from "./SpaceSwitcher";

export default function Sidebar({ me, spaceId }: { me: User; spaceId: string }) {
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
      <SpaceSwitcher />

      <div className="nav-group">
        {item(`/s/${spaceId}`, "My files", true)}
        {item(`/s/${spaceId}?vis=shared`, "Shared")}
        {item(`/s/${spaceId}?sort=modified`, "Recent")}
        {item(`/s/${spaceId}/trash`, "Trash")}
      </div>

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
