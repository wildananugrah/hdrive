import { useParams } from "react-router-dom";
import { useChildren, useSpaces } from "../api/queries";
import { isNotFound } from "../api/errors";
import FileTable from "../components/FileTable";
import EmptyState from "../components/EmptyState";

export default function Files() {
  const { spaceId = "", itemId = null } = useParams();
  const { data: spaces } = useSpaces();
  const { data: items, isPending, isError, error, refetch } = useChildren(spaceId, itemId);

  const spaceName = spaces?.find((s) => s.id === spaceId)?.name ?? "this space";

  if (isPending) return null;

  // isPending goes false on either success or error, so isError must be
  // checked explicitly before the empty-array branch — otherwise a server
  // fault renders as "nothing here yet" instead of a real error state.
  if (isError) {
    // 404 covers "no access" as well as "does not exist" — never say "forbidden".
    if (isNotFound(error)) {
      return <EmptyState title="Not found" hint="This folder does not exist, or you do not have access." />;
    }
    return (
      <div className="auth-retry" role="alert">
        <EmptyState title="Something went wrong" hint={(error as Error).message} />
        <button type="button" onClick={() => refetch()}>Retry</button>
      </div>
    );
  }

  return <FileTable items={items ?? []} spaceId={spaceId} spaceName={spaceName} />;
}
