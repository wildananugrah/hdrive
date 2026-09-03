import type { Item } from "../api/types";
import Modal from "./Modal";

export default function MoveModal(
  { item, folders, onMove, onClose, pending, foldersPending, foldersError, onRetryFolders, error }:
  {
    item: Item;
    folders: Item[];
    onMove: (parentId: string | null) => void;
    onClose: () => void;
    pending: boolean;
    // The folder list comes from its own query (GET .../folders), not a prop
    // the caller is assumed to already have — this modal owns rendering its
    // pending/error states rather than assuming `folders` is ever populated.
    foldersPending?: boolean;
    foldersError?: unknown;
    onRetryFolders?: () => void;
    // A move can 409 too (same endpoint as rename) when the destination
    // already has an item with this name — surfaced the same way as rename.
    error?: string | null;
  },
) {
  // A folder cannot move into itself or its own descendant. `path_ids` contains
  // every ancestor plus self, so a candidate whose path includes this item's id
  // is inside its subtree.
  const disabled = (f: Item) => f.id === item.id || f.path_ids.includes(item.id);

  return (
    <Modal title={`Move "${item.name}"`} onClose={onClose}>
      {error && <p role="alert" className="field-error">{error}</p>}
      {foldersPending ? (
        <p className="modal-hint">Loading folders…</p>
      ) : foldersError ? (
        <div className="auth-retry" role="alert">
          <p>Could not load folders.</p>
          {onRetryFolders && <button type="button" onClick={onRetryFolders}>Retry</button>}
        </div>
      ) : (
        <ul className="move-list">
          <li>
            <button type="button" onClick={() => onMove(null)} disabled={pending}>Space root</button>
          </li>
          {folders.filter((f) => f.kind === "folder").map((f) => (
            <li key={f.id}>
              <button type="button" onClick={() => onMove(f.id)} disabled={pending || disabled(f)}>
                {f.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
