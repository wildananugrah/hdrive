import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
// Vite statically rewrites the literal syntax `new URL('...', import.meta.url)`
// into an asset URL resolved against the dev server, which breaks a plain
// file read under vitest. Resolve the path with node:path instead.
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

// Guards against the likely failure mode of a bad font download: a 0-byte
// file or an HTML error page saved with a .woff2 extension. Both would
// silently fall back to a system font in the browser instead of erroring.
const files = [
  "bricolage-grotesque-400.woff2",
  "bricolage-grotesque-500.woff2",
  "bricolage-grotesque-600.woff2",
  "ibm-plex-mono-400.woff2",
  "ibm-plex-mono-500.woff2",
];

for (const name of files) {
  test(`${name} is a real, non-trivial woff2 file`, () => {
    const buf = readFileSync(join(here, "../public/fonts", name));
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.subarray(0, 4).toString("ascii")).toBe("wOF2");
  });
}
