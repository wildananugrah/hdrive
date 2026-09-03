import { Outlet, useParams } from "react-router-dom";
import { useMe, useSpaces } from "../api/queries";
import Sidebar from "../components/Sidebar";

export default function AppShell() {
  const { data: me } = useMe();
  const { data: spaces } = useSpaces();
  const { spaceId: paramSpaceId } = useParams();
  if (!me) return null; // RequireAuth guarantees a user; this is a type narrow.

  // Routes with no :spaceId segment (e.g. /settings, /admin/*) still need a
  // real space id for the sidebar's space-scoped links — falling back to ""
  // produced dead hrefs like "/s/". Fall back to the user's first space, and
  // let Sidebar omit that nav group entirely when there is no space at all.
  const spaceId = paramSpaceId ?? spaces?.[0]?.id;

  return (
    <div className="shell">
      <Sidebar me={me} spaceId={spaceId} />
      <div className="shell-main"><Outlet /></div>
    </div>
  );
}
