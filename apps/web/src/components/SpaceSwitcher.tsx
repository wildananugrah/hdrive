import { useNavigate, useParams } from "react-router-dom";
import { useSpaces } from "../api/queries";

// Spec §4's workspace switcher: sits atop the sidebar, navigates between
// spaces. A user with a single space still sees its name (no early return
// on length === 1) so the UI never looks broken for the common case.
export default function SpaceSwitcher() {
  const { data: spaces } = useSpaces();
  const { spaceId } = useParams();
  const nav = useNavigate();
  if (!spaces?.length) return null;

  return (
    <label className="space-switcher">
      <span className="mono-label">Workspace</span>
      <select value={spaceId ?? spaces[0].id} onChange={(e) => nav(`/s/${e.target.value}`)}>
        {spaces.map((s) => (
          <option key={s.id} value={s.id}>{s.name}</option>
        ))}
      </select>
    </label>
  );
}
