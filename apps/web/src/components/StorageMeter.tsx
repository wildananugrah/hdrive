import { useSpaceUsage } from "../api/queries";
import { formatBytes } from "../lib/format";

// There is deliberately no quota in this system — a bar or percentage would
// imply a ceiling that does not exist, so this renders a plain byte count
// and nothing else. isPending settles to false on error too (same trap as
// every other list in this app), so isError is checked explicitly: showing
// "0 B" on a failed request would misstate the user's actual usage, and
// hiding the meter is the honest failure mode.
export default function StorageMeter({ spaceId }: { spaceId: string }) {
  const usage = useSpaceUsage(spaceId);
  if (usage.isPending || usage.isError) return null;
  return <p className="mono-label storage-meter">{formatBytes(usage.data.bytes)} used</p>;
}
