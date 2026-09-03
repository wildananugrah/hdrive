import { useParams } from "react-router-dom";
import { useChildren, useSpaces, useUploads } from "../api/queries";
import { isNotFound } from "../api/errors";
import FileTable from "../components/FileTable";
import EmptyState from "../components/EmptyState";
import Dropzone from "../components/Dropzone";
import UploadToast from "../components/UploadToast";

export default function Files() {
  const { spaceId = "", itemId = null } = useParams();
  const { data: spaces } = useSpaces();
  const { data: items, isPending, isError, error, refetch } = useChildren(spaceId, itemId);
  const { uploads, start, retry, dismiss } = useUploads(spaceId, itemId);

  const spaceName = spaces?.find((s) => s.id === spaceId)?.name ?? "this space";

  // isPending goes false on either success or error, so isError must be
  // checked explicitly before the empty-array branch — otherwise a server
  // fault renders as "nothing here yet" instead of a real error state.
  const body = isPending ? null : isError ? (
    // 404 covers "no access" as well as "does not exist" — never say "forbidden".
    isNotFound(error) ? (
      <EmptyState title="Not found" hint="This folder does not exist, or you do not have access." />
    ) : (
      <div className="auth-retry" role="alert">
        <EmptyState title="Something went wrong" hint={(error as Error).message} />
        <button type="button" onClick={() => refetch()}>Retry</button>
      </div>
    )
  ) : (
    <FileTable items={items ?? []} spaceId={spaceId} spaceName={spaceName} parentId={itemId} />
  );

  return (
    <>
      <Dropzone onFiles={start} />
      {body}
      <UploadToast uploads={uploads} onRetry={retry} onDismiss={dismiss} />
    </>
  );
}
