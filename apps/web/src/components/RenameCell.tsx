import { useState } from "react";

// Inline edit, per the spec (not a modal) — `error` is a pre-computed,
// user-facing message (e.g. a 409 mapped to "already exists"); this
// component never inspects the underlying error itself.
export default function RenameCell(
  { name, onCommit, onCancel, error }:
  { name: string; onCommit: (next: string) => void; onCancel: () => void; error: string | null },
) {
  const [value, setValue] = useState(name);
  return (
    <div className="rename-cell">
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); onCommit(value.trim()); }
          if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        }}
        aria-label="New name"
      />
      {error && <p role="alert" className="field-error">{error}</p>}
    </div>
  );
}
