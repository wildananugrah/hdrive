import { useDeleteBackend, useProbeBackend, useSetWriteTarget } from "../../api/queries";
import { isConflict } from "../../api/errors";
import type { Backend } from "../../api/types";

export default function BackendRow({ backend }: { backend: Backend }) {
  const setWriteTarget = useSetWriteTarget();
  const probe = useProbeBackend();
  const del = useDeleteBackend();

  // The row already knows item_count (from listBackends), so this is a plain
  // client-side guard — no need to round-trip to the server just to learn
  // what the row already has. The API still refuses with 409 if this is ever
  // stale, and that 409 is rendered below as a fallback.
  const cannotDelete = backend.item_count > 0;

  return (
    <div className="admin-row backend-row">
      <div>
        <p>{backend.name}</p>
        <p className="mono-label">
          {backend.provider} · {backend.item_count} item{backend.item_count === 1 ? "" : "s"}
        </p>
      </div>

      {backend.is_write_target ? (
        <span className="pill">Write target</span>
      ) : (
        <button type="button" onClick={() => setWriteTarget.mutate(backend.id)} disabled={setWriteTarget.isPending}>
          Make write target
        </button>
      )}

      <div className="backend-probe">
        <button type="button" onClick={() => probe.mutate(backend.id)} disabled={probe.isPending}>
          {probe.isPending ? "Testing…" : "Test connection"}
        </button>
        {/* Every step, tick or cross, and the failing step's detail — a probe
            that only reports ok/fail can't diagnose a misconfigured
            provider, which is the entire point of running it at setup time. */}
        {probe.data && (
          <ul className="probe-steps">
            {probe.data.steps.map((s) => (
              <li key={s.step} className={s.ok ? "probe-ok" : "probe-fail"}>
                <span aria-hidden="true">{s.ok ? "✓" : "✗"}</span> <span>{s.step}</span>
                {!s.ok && s.detail && <p className="field-error">{s.detail}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <button
          type="button"
          className="btn-danger"
          onClick={() => del.mutate(backend.id)}
          disabled={cannotDelete || del.isPending}
          title={cannotDelete ? "This backend still holds files" : undefined}
        >
          Delete
        </button>
        {del.isError && (
          <p role="alert" className="field-error">
            {isConflict(del.error)
              ? "This backend still holds files and cannot be deleted."
              : (del.error as Error).message}
          </p>
        )}
      </div>
    </div>
  );
}
