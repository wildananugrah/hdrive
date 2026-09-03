import { Outlet, useParams } from "react-router-dom";
import { useMe } from "../api/queries";
import Sidebar from "../components/Sidebar";

export default function AppShell() {
  const { data: me } = useMe();
  const { spaceId } = useParams();
  if (!me) return null; // RequireAuth guarantees a user; this is a type narrow.
  return (
    <div className="shell">
      <Sidebar me={me} spaceId={spaceId ?? ""} />
      <div className="shell-main"><Outlet /></div>
    </div>
  );
}
