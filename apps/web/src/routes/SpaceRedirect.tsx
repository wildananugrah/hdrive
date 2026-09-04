// "/" has no meaning until a space is chosen.
import { useState } from "react";
import { Navigate } from "react-router-dom";
import { useSpaces } from "../api/queries";
import CreateSpaceModal from "../components/CreateSpaceModal";
import EmptyState from "../components/EmptyState";

export default function SpaceRedirect() {
  const { data: spaces, isPending, isError, refetch } = useSpaces();
  const [showCreate, setShowCreate] = useState(false);
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

  // The dead end: a fresh user (or one removed from their last space) lands
  // here with no way forward unless this offers one.
  if (!spaces?.length) {
    return (
      <>
        <EmptyState
          title="You are not a member of any space yet."
          hint="Create one to get started — you'll be its owner."
          action={
            <button type="button" className="btn-primary" onClick={() => setShowCreate(true)}>
              Create a space
            </button>
          }
        />
        {showCreate && <CreateSpaceModal onClose={() => setShowCreate(false)} />}
      </>
    );
  }
  return <Navigate to={`/space/${spaces[0].id}`} replace />;
}
