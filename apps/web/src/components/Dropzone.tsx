// The mockup's dashed empty-state affordance (border colour: var(--border-strong), 1px dashed).
import { useRef, useState } from "react";

export default function Dropzone({ onFiles }: { onFiles: (f: FileList | File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      className={`dropzone${over ? " is-over" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); onFiles(e.dataTransfer.files); }}
    >
      <button onClick={() => input.current?.click()}>Upload files</button>
      <input ref={input} type="file" multiple hidden
             onChange={(e) => { if (e.target.files) onFiles(e.target.files); e.target.value = ""; }} />
      <p>or drop them here</p>
    </div>
  );
}
