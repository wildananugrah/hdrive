import { expect, type Page } from "@playwright/test";

// Prerequisites: Postgres (5442) and MinIO (9200) up via `docker compose up -d`;
// the API running on 3011; the admin below seeded; a storage backend
// configured as the write target; and a space the admin owns.
//
// HAZARD: `bun test` in apps/api calls resetDb(), which TRUNCATEs every
// table — wiping this admin, the backend, and the space. Never run the API
// test suite while relying on this seeded environment for e2e. If it
// happens, re-seed with:
//   cd apps/api && bun run seed:admin admin@hdrive.local hunter2hunter2 "Admin"
// then re-create the backend and space through the API as that admin.
export const ADMIN = { email: "admin@hdrive.local", password: "hunter2hunter2" };

export async function signIn(page: Page, who = ADMIN) {
  await page.goto("/signin");
  await page.getByLabel(/email/i).fill(who.email);
  await page.getByLabel(/password/i).fill(who.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/signin/);
}

// Share and Delete live behind the row's "Item actions" menu button, not as
// top-level row buttons — open it before reaching for the menuitem.
export async function openRowMenu(page: Page, name: string) {
  const row = page.getByRole("row", { name: new RegExp(escapeRe(name)) });
  await row.getByRole("button", { name: /item actions/i }).click();
  return row;
}

// The upload toast never auto-dismisses (a known, documented simplification
// in useUploads) and sits fixed over the table, intercepting clicks on
// whatever row ends up underneath it. Clear it before interacting with a row.
export async function dismissUploadToast(page: Page, name: string) {
  const toastRow = page.locator(".toast-row", { hasText: name });
  const dismiss = toastRow.getByRole("button", { name: /dismiss/i });
  await expect(dismiss).toBeVisible({ timeout: 10_000 });
  await dismiss.click();
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
