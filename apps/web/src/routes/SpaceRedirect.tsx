// "/" has no meaning until a space is chosen.
import { Navigate } from "react-router-dom";
import { useSpaces } from "../api/queries";

export default function SpaceRedirect() {
  const { data: spaces, isPending, isError, refetch } = useSpaces();
  if (isPending) return null;

  // A failed /api/spaces request is not the same fact as "no spaces": isPending
  // goes false on either success or error, so this must be checked before the
  // empty-array branch or a server fault reads as "you have no spaces."
  if (isError) {
    return (
      <div className="auth-retry" role="alert">
        <p>Couldn't load your spaces. Check your connection and try again.</p>
        <button type="button" onClick={() => refetch()}>Retry</button>
      </div>
    );
  }

  if (!spaces?.length) return <div className="empty">You are not a member of any space yet.</div>;
  return <Navigate to={`/space/${spaces[0].id}`} replace />;
}
