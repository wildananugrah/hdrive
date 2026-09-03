import type { Visibility } from "../lib/visibility";

const LABEL: Record<Visibility, string> = { space: "Space", shared: "Shared", public: "Public" };

export default function VisibilityBadge(
  { visibility, spaceName, extraCount }:
  { visibility: Visibility; spaceName?: string; extraCount?: number },
) {
  // Copy is corrected from the mockup: the backend is grant-only with no deny
  // rules, so "only you" is not expressible — every space member sees
  // everything in the space. See spec §3.
  // extraCount is only known in detail views that hold the full grant list;
  // list rows get their tier from flags with no count, so the tooltip must
  // not invent a number there.
  const title =
    visibility === "space"  ? `Everyone in ${spaceName ?? "this space"}`
  : visibility === "shared" ? (extraCount != null ? `Space members, plus ${extraCount} more` : "Space members, plus others")
  :                           "Anyone with the link, no sign-in";

  return (
    <span className={`vis vis-${visibility}`} title={title}>
      <span className="vis-dot" aria-hidden="true" />
      {LABEL[visibility]}
    </span>
  );
}
