import { useParams } from "react-router-dom";
import { useRestoreItem, useTrash } from "../api/queries";
import { isConflict } from "../api/errors";
import EmptyState from "../components/EmptyState";
import { formatDate } from "../lib/format";

export default function Trash() {
  const { spaceId = "" } = useParams();
  const { data: items, isPending, isError, error, refetch } = useTrash(spaceId);
  const restore = useRestoreItem(spaceId);

  // isPending goes false on either success or error, so isError must be
  // checked explicitly before the empty-array branch — otherwise a server
  // fault renders as "trash is empty" instead of a real error state.
  if (isPending) return null;

  if (isError) {
    return (
      <div className="auth-retry" role="alert">
        <EmptyState title="Something went wrong" hint={(error as Error).message} />
        <button type="button" onClick={() => refetch()}>Retry</button>
      </div>
    );
  }

  if (!items?.length) {
    return <EmptyState title="Trash is empty" hint="Deleted items appear here for 30 days." />;
  }

  return (
    <>
      {restore.error && (
        <p role="alert" className="field-error">
          {/* Soft-delete frees a name, so restoring into a reused name is a
              legitimate 409 — tell the user what to do about it, not just that
              it failed. */}
          {isConflict(restore.error)
            ? "Something already has that name. Rename it, then restore."
            : (restore.error as Error).message}
        </p>
      )}
      <table className="file-table">
        <thead>
          <tr>{["NAME", "DELETED", ""].map((h) => <th key={h} className="mono-label">{h}</th>)}</tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr key={it.id}>
              <td>{it.name}</td>
              <td>{it.deleted_at ? formatDate(it.deleted_at) : "—"}</td>
              <td>
                <button onClick={() => restore.mutate(it.id)} disabled={restore.isPending}>
                  Restore
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
