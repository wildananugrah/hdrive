import { useEffect, useRef, useState } from "react";

export default function RowMenu(
  { onRename, onMove, onShare, onDelete }:
  { onRename: () => void; onMove: () => void; onShare: () => void; onDelete: () => void },
) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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
          <li><button type="button" role="menuitem" onClick={act(onShare)}>Share</button></li>
          <li><button type="button" role="menuitem" onClick={act(onDelete)}>Delete</button></li>
        </ul>
      )}
    </div>
  );
}
