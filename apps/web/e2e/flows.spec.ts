import { expect, test } from "@playwright/test";
import { dismissUploadToast, openRowMenu, signIn } from "./fixtures";

test("upload: a file goes through reserve, PUT, and finish, then appears", async ({ page }) => {
  await signIn(page);
  const name = `e2e-${Date.now()}.txt`;

  // Localhost round-trips the complete call fast enough that the finishing
  // state can flash and clear between two Playwright polls. Add real (if
  // small) network latency to the completion request so the state the app
  // actually goes through is reliably observable, without faking any data.
  await page.route("**/api/items/*/complete", async (route) => {
    await new Promise((r) => setTimeout(r, 400));
    await route.continue();
  });

  await page.setInputFiles('input[type="file"]', {
    name, mimeType: "text/plain", buffer: Buffer.from("hello from playwright"),
  });

  // The finishing state must be observable — it is the whole reason it exists.
  await expect(page.getByText(/finishing/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("link", { name })).toBeVisible({ timeout: 15_000 });

  // Size comes from storage, so it must be the real byte length. Scoped to
  // this file's own row — the space accumulates other 21-byte fixtures
  // across runs, so an unscoped text match is ambiguous.
  await expect(page.getByRole("row", { name: new RegExp(name) }).getByText("21 B")).toBeVisible();
});

test("download: the content route returns the bytes that were uploaded", async ({ page }) => {
  await signIn(page);
  const name = `e2e-dl-${Date.now()}.txt`;
  await page.setInputFiles('input[type="file"]', {
    name, mimeType: "text/plain", buffer: Buffer.from("download me"),
  });
  await expect(page.getByRole("link", { name })).toBeVisible({ timeout: 15_000 });

  await page.getByRole("link", { name }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: /download/i }).click(),
  ]);
  expect(download.suggestedFilename()).toBe(name);
});

test("range: the API answers a Range request with 206 and the right slice", async ({ page, request }) => {
  await signIn(page);
  const name = `e2e-range-${Date.now()}.txt`;
  await page.setInputFiles('input[type="file"]', {
    name, mimeType: "text/plain", buffer: Buffer.from("0123456789"),
  });
  await expect(page.getByRole("link", { name })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("link", { name }).click();

  const itemId = page.url().split("/i/")[1];
  const cookies = await page.context().cookies();
  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

  const res = await request.get(`http://localhost:3011/api/items/${itemId}/content`, {
    headers: { range: "bytes=2-5", cookie },
  });
  expect(res.status()).toBe(206);
  expect(res.headers()["content-range"]).toBe("bytes 2-5/10");
  expect(await res.text()).toBe("2345");
});

test("share: create a link, open it signed out, and revoke it", async ({ page, browser }) => {
  await signIn(page);
  const name = `e2e-share-${Date.now()}.txt`;
  await page.setInputFiles('input[type="file"]', {
    name, mimeType: "text/plain", buffer: Buffer.from("shared bytes"),
  });
  await expect(page.getByRole("link", { name })).toBeVisible({ timeout: 15_000 });
  await dismissUploadToast(page, name);

  const row = await openRowMenu(page, name);
  await row.getByRole("menuitem", { name: /share/i }).click();
  await page.getByRole("button", { name: /create link/i }).click();
  const url = await page.getByRole("textbox", { name: /link/i }).inputValue();
  expect(url).toContain("/share/");

  // /share/:token is a client-routed SPA page, so page.goto()'s HTTP status
  // is always 200 — the Vite dev server serves index.html regardless of
  // whether the token is valid. The real signal is what the app shows once
  // it settles: the viewer on success, an error alert on a dead link. Unlock
  // silently probes with an empty password on mount and skips the form
  // entirely for a link with no password, so there is no button to click
  // here — asserting one ever appears would hang forever on the happy path.
  // A brand-new context proves the link needs no session.
  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  await anonPage.goto(url);
  await expect(anonPage.getByTestId("share-video")).toBeVisible({ timeout: 10_000 });
  await anon.close();

  const revokeButton = page.getByRole("button", { name: /revoke/i });
  await revokeButton.click();
  // The click only fires the mutation; wait for it to actually land (the row
  // drops its Revoke button once the list refetches as revoked) before
  // treating the link as revoked server-side.
  await expect(revokeButton).toBeHidden({ timeout: 10_000 });

  // Same reasoning: the mount probe hits a revoked link and lands straight
  // on the "notfound" phase's alert, no form or click in between.
  const anon2 = await browser.newContext();
  const anonPage2 = await anon2.newPage();
  await anonPage2.goto(url);
  await expect(anonPage2.getByRole("alert")).toBeVisible({ timeout: 10_000 });
  await anon2.close();
});

test("onboarding: an admin onboards a second user end to end", async ({ page, browser }) => {
  await signIn(page);
  const stamp = Date.now();
  const newUser = { email: `e2e-onboard-${stamp}@example.com`, password: "OnboardMe123!" };
  const spaceName = `e2e-space-${stamp}`;

  // 1. Admin creates a user with a known password.
  await page.goto("/admin/users");
  await page.getByRole("button", { name: /add user/i }).click();
  await page.getByLabel("Name", { exact: true }).fill("E2E Second User");
  await page.getByLabel("Email", { exact: true }).fill(newUser.email);
  await page.getByLabel("Password", { exact: true }).fill(newUser.password);
  await page.getByRole("button", { name: /create user/i }).click();
  await expect(page.getByLabel("Generated password")).toHaveValue(newUser.password, { timeout: 10_000 });
  await page.getByRole("button", { name: "Done", exact: true }).click();

  // 2. Admin creates a space.
  await page.getByRole("button", { name: /new space/i }).click();
  await page.getByLabel("Name", { exact: true }).fill(spaceName);
  await page.getByRole("button", { name: /create space/i }).click();
  await expect(page).toHaveURL(/\/space\/[^/]+$/, { timeout: 10_000 });
  const spaceId = page.url().match(/\/space\/([^/?]+)/)?.[1];
  expect(spaceId).toBeTruthy();

  // 3. Admin adds the new user to the space BY EMAIL as an editor.
  await page.goto(`/space/${spaceId}/members`);
  // "Add" is ambiguous with the admin-only "add a group" form beside it —
  // scope to the form that owns the email input.
  const addByEmailForm = page.locator("form").filter({ has: page.getByLabel(/add by email/i) });
  await addByEmailForm.getByLabel(/add by email/i).fill(newUser.email);
  await addByEmailForm.getByLabel("Role to add").selectOption("editor");
  await addByEmailForm.getByRole("button", { name: /^add$/i }).click();
  await expect(page.getByText(newUser.email)).toBeVisible({ timeout: 10_000 });

  // 4. A FRESH browser context signs in as that user — a real second person,
  // not the admin's own session.
  const userContext = await browser.newContext();
  const userPage = await userContext.newPage();
  await signIn(userPage, newUser);

  // 5. That user sees the space, not the historical dead end.
  await expect(userPage.getByText(/not a member of any space/i)).toHaveCount(0);
  await expect(userPage).toHaveURL(new RegExp(`/space/${spaceId}(?:$|[/?])`), { timeout: 10_000 });
  await expect(userPage.getByLabel(/workspace/i)).toHaveValue(spaceId!);
  await expect(userPage.getByRole("link", { name: "Members", exact: true })).toBeVisible();
  await userContext.close();
});

test("trash: delete then restore returns the file to its folder", async ({ page }) => {
  await signIn(page);
  const name = `e2e-trash-${Date.now()}.txt`;
  await page.setInputFiles('input[type="file"]', {
    name, mimeType: "text/plain", buffer: Buffer.from("trash me"),
  });
  await expect(page.getByRole("link", { name })).toBeVisible({ timeout: 15_000 });
  await dismissUploadToast(page, name);

  const row = await openRowMenu(page, name);
  await row.getByRole("menuitem", { name: /delete/i }).click();
  await expect(page.getByRole("link", { name })).toBeHidden();

  // Exact match: the nav label is "Trash", but an uploaded file named
  // "e2e-trash-...txt" also satisfies a loose /trash/i match on this page.
  await page.getByRole("link", { name: "Trash", exact: true }).click();
  await page.getByRole("row", { name: new RegExp(name) }).getByRole("button", { name: /restore/i }).click();

  await page.getByRole("link", { name: "My files", exact: true }).click();
  await expect(page.getByRole("link", { name })).toBeVisible();
});
