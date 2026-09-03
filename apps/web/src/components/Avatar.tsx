// Avatar.tsx — initials on a tinted background, per the mockup's avatar variants.
// The five bg/fg pairs live in tokens.css as --avatar-1-bg/fg .. --avatar-5-bg/fg;
// a hash of the name deterministically picks one pair.
const TINT_COUNT = 5;

export default function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("");
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const tint = (h % TINT_COUNT) + 1;
  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.4,
        background: `var(--avatar-${tint}-bg)`,
        color: `var(--avatar-${tint}-fg)`,
      }}
    >
      {initials}
    </span>
  );
}
