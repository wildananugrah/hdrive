import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
// Vite statically rewrites the literal syntax `new URL('...', import.meta.url)`
// into an asset URL resolved against the dev server (http://localhost:3000/),
// which breaks a plain file read under vitest. Resolve the path with
// node:path instead so it stays a real filesystem path.
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "../src/styles/tokens.css"), "utf8");

test("every token the design depends on is defined", () => {
  for (const name of [
    "--brand", "--brand-hover", "--brand-tint", "--on-brand", "--on-brand-secondary",
    "--text", "--text-secondary", "--text-tertiary",
    "--bg", "--surface", "--border", "--divider",
    "--success", "--danger", "--warning",
    "--vis-space", "--vis-shared", "--vis-public",
    "--font-ui", "--font-mono",
    "--r-control", "--r-card", "--r-modal", "--r-pill",
    "--shadow-modal", "--shadow-toast", "--shadow-dropdown",
  ]) {
    expect(css).toContain(`${name}:`);
  }
});

test("brand and visibility colours match the extracted design exactly", () => {
  expect(css).toMatch(/--brand:\s*#3B3BE8/i);
  expect(css).toMatch(/--brand-hover:\s*#2323C4/i);
  expect(css).toMatch(/--vis-shared:\s*#3B3BE8/i);
  expect(css).toMatch(/--vis-public:\s*#1F7A4C/i);
  expect(css).toMatch(/--vis-space:\s*#5B6169/i);
});

test("on-brand text colours match the login-panel extraction exactly", () => {
  expect(css).toMatch(/--on-brand:\s*#FFFFFF/i);
  expect(css).toMatch(/--on-brand-secondary:\s*#D6D6FB/i);
});

test("font stacks name the self-hosted faces, with system fallbacks, not a bare system font", () => {
  expect(css).toMatch(/--font-ui:\s*'Bricolage Grotesque'/i);
  expect(css).toMatch(/--font-mono:\s*'IBM Plex Mono'/i);
});
