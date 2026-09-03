import type { UploadState } from "../api/queries";

const LABEL: Record<UploadState["phase"], string> = {
  reserving: "Preparing…",
  uploading: "",           // replaced by the percentage
  finishing: "Finishing…", // bytes are up; the server is confirming
  done: "Uploaded",
  failed: "Failed",
};

export default function UploadToast(
  { uploads, onRetry, onDismiss }:
  { uploads: UploadState[]; onRetry: (id: string) => void; onDismiss: (id: string) => void },
) {
  if (uploads.length === 0) return null;
  return (
    <div className="toast rise" role="status" aria-live="polite">
      {uploads.map((up) => (
        <div key={up.id} className="toast-row">
          <span className="toast-name">{up.name}</span>
          <span className="toast-status">
            {up.phase === "uploading" ? `${Math.round(up.progress * 100)}%` : LABEL[up.phase]}
          </span>
          {up.phase !== "failed" && (
            <div className="toast-bar"><div style={{ width: `${up.progress * 100}%` }} /></div>
          )}
          {up.phase === "failed" && (
            <>
              <span className="toast-error">{up.error}</span>
              <button onClick={() => onRetry(up.id)}>Retry</button>
            </>
          )}
          {(up.phase === "done" || up.phase === "failed") && (
            <button aria-label="Dismiss" onClick={() => onDismiss(up.id)}>×</button>
          )}
        </div>
      ))}
    </div>
  );
}
