import { useState } from "react";
import { Link } from "react-router-dom";
import { useDeleteItem, useMoveItem, useRenameItem, useSpaceFolders } from "../api/queries";
import { isConflict } from "../api/errors";
import type { Item } from "../api/types";
import { formatBytes, formatDate } from "../lib/format";
import { visibilityFromFlags } from "../lib/visibility";
import EmptyState from "./EmptyState";
import MoveModal from "./MoveModal";
import RenameCell from "./RenameCell";
import RowMenu from "./RowMenu";
import VisibilityBadge from "./VisibilityBadge";

const conflictMessage = (kind: "rename" | "move") =>
  kind === "rename"
    ? "An item with that name already exists here."
    : "An item with that name already exists in that folder.";

export default function FileTable(
  { items, spaceId, spaceName, parentId = null }:
  { items: Item[]; spaceId: string; spaceName: string; parentId?: string | null },
) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [movingItem, setMovingItem] = useState<Item | null>(null);

  const rename = useRenameItem(spaceId, parentId);
  const move = useMoveItem(spaceId, parentId);
  const del = useDeleteItem(spaceId, parentId);
  // Only fetch the folder tree while a move is actually being picked.
  const folders = useSpaceFolders(spaceId, movingItem !== null);

  if (items.length === 0) {
    return <EmptyState title="Nothing here yet" hint="Upload a file to get started." />;
  }

  const startRename = (id: string) => { rename.reset(); setRenamingId(id); };
  const cancelRename = () => { rename.reset(); setRenamingId(null); };
  const commitRename = (id: string, name: string, current: string) => {
    if (!name || name === current) { cancelRename(); return; }
    rename.mutate({ id, name }, { onSuccess: () => setRenamingId(null) });
  };

  const renameError = renamingId && rename.error
    ? (isConflict(rename.error) ? conflictMessage("rename") : (rename.error as Error).message)
    : null;

  const moveError = movingItem && move.error
    ? (isConflict(move.error) ? conflictMessage("move") : (move.error as Error).message)
    : null;

  return (
    <>
      <table className="file-table">
        <thead>
          <tr>
            {["NAME", "OWNER", "VISIBILITY", "SIZE", "MODIFIED", ""].map((h) => (
              <th key={h} className="mono-label">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr key={it.id}>
              <td>
                {renamingId === it.id ? (
                  <RenameCell
                    name={it.name}
                    onCommit={(next) => commitRename(it.id, next, it.name)}
                    onCancel={cancelRename}
                    error={renameError}
                  />
                ) : it.status === "pending" ? (
                  // Still uploading: /i/:id would only 409 on content, so this
                  // is a plain non-interactive label, not a Link.
                  <span>{it.name}</span>
                ) : (
                  <Link to={it.kind === "folder" ? `/s/${spaceId}/f/${it.id}` : `/i/${it.id}`}>
                    {it.name}
                  </Link>
                )}
                {it.status === "pending" && <span className="pill-muted">Uploading…</span>}
              </td>
              <td>—</td>
              <td>
                {/* has_grants/has_live_share come precomputed from the children
                    endpoint, so this never fires a grants+shares call per row. */}
                <VisibilityBadge visibility={visibilityFromFlags(it)} spaceName={spaceName} />
              </td>
              <td>{it.kind === "folder" ? "—" : formatBytes(it.size)}</td>
              <td>{formatDate(it.created_at)}</td>
              <td>
                <RowMenu
                  onRename={() => startRename(it.id)}
                  onMove={() => { move.reset(); setMovingItem(it); }}
                  onDelete={() => del.mutate(it.id)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {movingItem && (
        <MoveModal
          item={movingItem}
          folders={folders.data ?? []}
          foldersPending={folders.isPending}
          foldersError={folders.isError ? folders.error : undefined}
          onRetryFolders={() => folders.refetch()}
          error={moveError}
          pending={move.isPending}
          onMove={(nextParentId) =>
            move.mutate(
              { id: movingItem.id, parent_id: nextParentId },
              { onSuccess: () => setMovingItem(null) },
            )
          }
          onClose={() => setMovingItem(null)}
        />
      )}
    </>
  );
}
