// Avatar.tsx — initials on a tinted background, per the mockup's avatar variants.
// The five bg/fg pairs are a seeded palette (hash of the name picks one), not a
// single reusable semantic colour, so they stay literal rather than becoming tokens.
const TINTS = [
  ["#DEDEFB", "#3B3BE8"],
  ["#E4EEFB", "#1D4ED8"],
  ["#F3E8FF", "#6B21A8"],
  ["#FDE7D6", "#C2410C"],
  ["#E8F5EE", "#1F7A4C"],
] as const;

export default function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("");
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const [bg, fg] = TINTS[h % TINTS.length];
  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={{ width: size, height: size, background: bg, color: fg, fontSize: size * 0.4 }}
    >
      {initials}
    </span>
  );
}
