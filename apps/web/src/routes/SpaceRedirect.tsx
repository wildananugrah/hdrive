// "/" has no meaning until a space is chosen.
import { Navigate } from "react-router-dom";
import { useSpaces } from "../api/queries";

export default function SpaceRedirect() {
  const { data: spaces, isPending } = useSpaces();
  if (isPending) return null;
  if (!spaces?.length) return <div className="empty">You are not a member of any space yet.</div>;
  return <Navigate to={`/s/${spaces[0].id}`} replace />;
}
