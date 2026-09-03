import { useEffect, useRef, useState } from "react";

export default function RowMenu(
  { kind, status, onRename, onMove, onShare, onManageAccess, onDelete }:
  {
    kind: "file" | "folder"; status: "pending" | "ready";
    onRename: () => void; onMove: () => void; onShare: () => void;
    onManageAccess: () => void; onDelete: () => void;
  },
) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // The API rejects sharing a folder and sharing a non-ready item with a 400
  // (and grants need OWNER, which a folder/pending item can't usefully reach
  // here either), so disable rather than hide — the row already carries
  // kind/status, no extra fetch needed.
  const disabledReason =
    kind === "folder" ? "Folders can't be shared"
    : status !== "ready" ? "Still uploading"
    : null;

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const act = (fn: () => void) => () => { setOpen(false); fn(); };

  return (
    <div className="row-menu" ref={ref}>
      <button type="button" aria-label="Item actions" onClick={() => setOpen((o) => !o)}>⋯</button>
      {open && (
        <ul className="row-menu-list" role="menu">
          <li><button type="button" role="menuitem" onClick={act(onRename)}>Rename</button></li>
          <li><button type="button" role="menuitem" onClick={act(onMove)}>Move</button></li>
          <li>
            <button
              type="button" role="menuitem" onClick={act(onShare)}
              disabled={disabledReason !== null} title={disabledReason ?? undefined}
            >
              Share
            </button>
          </li>
          <li>
            <button
              type="button" role="menuitem" onClick={act(onManageAccess)}
              disabled={disabledReason !== null} title={disabledReason ?? undefined}
            >
              Manage access
            </button>
          </li>
          <li><button type="button" role="menuitem" onClick={act(onDelete)}>Delete</button></li>
        </ul>
      )}
    </div>
  );
}
