import { Link } from "react-router-dom";
import type { Item } from "../api/types";
import { formatBytes, formatDate } from "../lib/format";
import { visibilityFromFlags } from "../lib/visibility";
import EmptyState from "./EmptyState";
import VisibilityBadge from "./VisibilityBadge";

export default function FileTable(
  { items, spaceId, spaceName }: { items: Item[]; spaceId: string; spaceName: string },
) {
  if (items.length === 0) {
    return <EmptyState title="Nothing here yet" hint="Upload a file to get started." />;
  }

  return (
    <table className="file-table">
      <thead>
        <tr>
          {["NAME", "OWNER", "VISIBILITY", "SIZE", "MODIFIED"].map((h) => (
            <th key={h} className="mono-label">{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {items.map((it) => (
          <tr key={it.id}>
            <td>
              {it.status === "pending" ? (
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
          </tr>
        ))}
      </tbody>
    </table>
  );
}
