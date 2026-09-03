import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import App from "../src/App";
import FileTable from "../src/components/FileTable";
import ShareModal from "../src/components/ShareModal";
import Unlock from "../src/routes/share/Unlock";
import { useCreateShare, useRevokeShare } from "../src/api/queries";
import type { Item, ShareLink } from "../src/api/types";

const newClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

const wrap = (ui: React.ReactNode, initial = "/share/tok123", client = newClient()) =>
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes><Route path="/share/:token" element={ui} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

const wrapModal = (ui: React.ReactNode, client = newClient()) =>
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);

const res = (status: number, body: unknown, extraHeaders: Record<string, string> = {}) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });

const item = (over: Partial<Item> = {}): Item => ({
  id: "i1", space_id: "s1", parent_id: null, kind: "file", name: "clip.mp4",
  path_ids: ["i1"], size: 2048, mime: "video/mp4", storage_backend_id: "b1",
  storage_key: "s1/i1", status: "ready", deleted_at: null, created_by: "u1",
  created_at: "2026-09-01T00:00:00Z", has_grants: false, has_live_share: false, ...over,
});

const shareLink = (over: Partial<ShareLink> = {}): ShareLink => ({
  id: "sl1", mode: "view", expires_at: "2026-09-10T00:00:00Z",
  revoked_at: null, created_at: "2026-09-03T00:00:00Z", has_password: false, ...over,
});

afterEach(() => vi.unstubAllGlobals());

// ---- Unlock — from the brief -----------------------------------------------

test("a wrong password says so and lets the viewer retry", async () => {
  // Two calls happen here (the mount probe, then the submit), each reading
  // the response body — a Response can only be read once, so this must
  // build a fresh one per call rather than reuse a single mocked instance.
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(res(401, { error: "password required" }))));
  wrap(<Unlock />);
  // The mount probe (empty password) also 401s here, so the form is already
  // showing by the time we interact with it — see the dedicated probe tests
  // below for that transition itself.
  await userEvent.type(await screen.findByLabelText(/password/i), "nope");
  await userEvent.click(screen.getByRole("button", { name: /unlock|view/i }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/password/i);
  expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
});

test("a 404 gives ONE uniform message and no hint about which reason", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res(404, { error: "link not found or expired" })));
  wrap(<Unlock />);
  // No password prompt for a 404 — the mount probe alone is enough to know
  // there's nothing to unlock, so no form is ever rendered.
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(/not found or expired/i);
  // The API refuses to distinguish these; the UI must not invent a distinction.
  expect(alert.textContent).not.toMatch(/revoked/i);
  expect(alert.textContent).not.toMatch(/deleted/i);
  expect(alert.textContent).not.toMatch(/this link expired/i);
  expect(screen.queryByLabelText(/password/i)).toBeNull();
});

test("the unlock page has no app chrome — the viewer is not signed in", () => {
  vi.stubGlobal("fetch", vi.fn());
  wrap(<Unlock />);
  expect(screen.queryByText(/my files/i)).toBeNull();
  expect(screen.queryByText(/log out/i)).toBeNull();
});

// ---- Unlock — the mount probe (predicate #2 target) ------------------------
// FIX 3: the backend skips password verification when a link has none, so
// the old code path — always render the form, submit an empty password to
// find out — forced every no-password recipient through a click and the
// nginx unlock rate limit for nothing. Unlock now probes once on mount.

test("a no-password link renders the viewer directly, without ever showing a prompt", async () => {
  const fetchMock = vi.fn().mockResolvedValue(res(204, null));
  vi.stubGlobal("fetch", fetchMock);
  wrap(<Unlock />);
  expect(await screen.findByTestId("share-video")).toBeInTheDocument();
  expect(screen.queryByText(/password protected/i)).toBeNull();
  expect(screen.queryByLabelText(/password/i)).toBeNull();
  // Exactly one probe call to /unlock, not a loop — ShareView also fires its
  // own (unrelated) ranged request for the Content-Disposition header, so
  // this counts only the /unlock calls, not every call fetchMock saw.
  await waitFor(() => {
    const unlockCalls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/unlock"));
    expect(unlockCalls).toHaveLength(1);
  });
});

test("a password-protected link renders the prompt only after the probe's 401", async () => {
  const fetchMock = vi.fn().mockResolvedValue(res(401, { error: "password required" }));
  vi.stubGlobal("fetch", fetchMock);
  wrap(<Unlock />);
  // Nothing — not even the form — before the probe resolves.
  expect(screen.queryByLabelText(/password/i)).toBeNull();
  expect(await screen.findByLabelText(/password/i)).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: /password protected/i })).toBeInTheDocument();
  // The silent probe itself must not surface an error message.
  expect(screen.queryByRole("alert")).toBeNull();
});

test("unlocking sends credentials so the short-lived cookie is actually stored", async () => {
  const fetchMock = vi.fn().mockResolvedValue(res(204, null));
  vi.stubGlobal("fetch", fetchMock);
  wrap(<Unlock />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  const [url, init] = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/unlock"))!;
  expect(String(url)).toContain("/s/tok123/unlock");
  expect(init?.credentials).toBe("include");
});

test("a successful unlock renders the streamed viewer with a credentialed video element", async () => {
  const fetchMock = vi.fn((url: string) =>
    String(url).endsWith("/unlock") ? Promise.resolve(res(204, null)) : Promise.resolve(res(200, null)),
  );
  vi.stubGlobal("fetch", fetchMock);
  wrap(<Unlock />);
  const video = await screen.findByTestId("share-video");
  expect(video.getAttribute("src")).toContain("/s/tok123");
  expect(video.getAttribute("crossorigin")).toBe("use-credentials");
});

test("a view-mode link hides the download button (server's inline Content-Disposition)", async () => {
  const fetchMock = vi.fn((url: string) =>
    String(url).endsWith("/unlock")
      ? Promise.resolve(res(204, null))
      : Promise.resolve(res(206, null, { "content-disposition": "inline; filename=\"clip.mp4\"" })),
  );
  vi.stubGlobal("fetch", fetchMock);
  wrap(<Unlock />);
  await screen.findByTestId("share-video");
  await waitFor(() => expect(screen.queryByRole("link", { name: /download/i })).toBeNull());
});

test("a download-mode link shows the download button", async () => {
  const fetchMock = vi.fn((url: string) =>
    String(url).endsWith("/unlock")
      ? Promise.resolve(res(204, null))
      : Promise.resolve(res(206, null, { "content-disposition": "attachment; filename=\"clip.mp4\"" })),
  );
  vi.stubGlobal("fetch", fetchMock);
  wrap(<Unlock />);
  await screen.findByTestId("share-video");
  expect(await screen.findByRole("link", { name: /download/i })).toBeInTheDocument();
});

// ---- Route placement (predicate #4 target; not in the brief's test list) ---

test("/share/:token is reachable while signed out — it must sit outside RequireAuth", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res(401, { error: "unauthorized" })));
  render(
    <QueryClientProvider client={newClient()}>
      <MemoryRouter initialEntries={["/share/tok123"]}><App /></MemoryRouter>
    </QueryClientProvider>,
  );
  // If this route were nested under RequireAuth, an anonymous session (the
  // normal case for a share recipient) would redirect to /signin instead.
  expect(await screen.findByText(/password protected/i)).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: /^sign in$/i })).toBeNull();
});

// ---- ShareModal ---------------------------------------------------------

test("a created link shows the one-time-only warning and the token, once", async () => {
  const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      return Promise.resolve(res(201, {
        id: "sl2", mode: "view", expires_at: "2026-09-10T00:00:00Z",
        revoked_at: null, created_at: "2026-09-03T00:00:00Z", has_password: false,
        token: "brand-new-token",
      }, {}));
    }
    return Promise.resolve(res(200, []));
  });
  vi.stubGlobal("fetch", fetchMock);
  wrapModal(<ShareModal item={item()} onClose={() => {}} />);
  await userEvent.click(await screen.findByRole("button", { name: /create link/i }));

  expect(await screen.findByText(/shown only once/i)).toBeInTheDocument();
  expect(screen.getByText(/cannot be retrieved again/i)).toBeInTheDocument();
  const input = screen.getByLabelText(/share link/i) as HTMLInputElement;
  expect(input.value).toContain("/share/brand-new-token");
  expect(input).toHaveAttribute("readonly");
  expect(screen.getByRole("button", { name: /^copy$/i })).toBeInTheDocument();
});

test("an existing link in the list never renders a token or share URL — the API cannot return one", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res(200, [shareLink()])));
  wrapModal(<ShareModal item={item()} onClose={() => {}} />);
  // "No password" only ever comes from a rendered list row (unlike "View
  // only", which is also a static <option> in the mode <select> above and
  // would resolve before the list has actually loaded).
  await screen.findByText(/no password/i);
  expect(screen.queryByLabelText(/share link/i)).toBeNull();
  expect(document.body.textContent).not.toMatch(/\/share\//);
});

test("the expiry defaults to 7 days, and 'never' is a distinct opt-in, not the easy default", () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res(200, [])));
  wrapModal(<ShareModal item={item()} onClose={() => {}} />);
  const select = screen.getByLabelText(/expires/i) as HTMLSelectElement;
  const never = screen.getByRole("checkbox", { name: /never expire/i }) as HTMLInputElement;
  expect(select.value).toBe("7");
  expect(never.checked).toBe(false);
});

test("checking 'never expire' is an explicit action that disables the days select", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res(200, [])));
  wrapModal(<ShareModal item={item()} onClose={() => {}} />);
  const never = screen.getByRole("checkbox", { name: /never expire/i });
  await userEvent.click(never);
  expect(screen.getByLabelText(/expires/i)).toBeDisabled();
});

// State-branch requirement: isPending settles false on error too, so a 500
// must not be read as "no links yet".
test("a 500 loading existing links shows a retry affordance, never 'No links yet'", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res(500, { error: "internal error" })));
  wrapModal(<ShareModal item={item()} onClose={() => {}} />);
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  expect(screen.queryByText(/no links yet/i)).toBeNull();
});

// ---- FileTable wiring (FileTable.tsx is a Modify target for this task) -----

test("the row menu offers Share, opening the share modal for that row's item", async () => {
  const fetchMock = vi.fn().mockResolvedValue(res(200, []));
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider client={newClient()}>
      <MemoryRouter>
        <FileTable items={[item()]} spaceId="s1" spaceName="Studio" parentId={null} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: /item actions/i }));
  await userEvent.click(screen.getByRole("menuitem", { name: /share/i }));
  expect(await screen.findByRole("dialog", { name: /share/i })).toBeInTheDocument();
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/items/i1/shares"), expect.anything()),
  );
});

// ---- Cache invalidation — FIX 2 --------------------------------------------
// The row's visibility badge (Space/Shared/Public) reads has_grants/
// has_live_share off the ["children", spaceId, parentId] cache (FileTable),
// which is a different cache entry than ["shares", itemId]. Without also
// invalidating ["children"], a row created a share for still reads "Space"
// until the listing is invalidated some other way — and main.tsx disables
// refetchOnWindowFocus, so it never self-corrects.
// This is what predicate-break #1 targets.

function CreateShareHarness({ itemId }: { itemId: string }) {
  const create = useCreateShare(itemId);
  return <button onClick={() => create.mutate({ mode: "view" })}>create</button>;
}

function RevokeShareHarness({ itemId }: { itemId: string }) {
  const revoke = useRevokeShare(itemId);
  return <button onClick={() => revoke.mutate("sl1")}>revoke</button>;
}

test("creating a share link invalidates the children listing so the badge updates", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res(201, {
    id: "sl2", mode: "view", expires_at: null, revoked_at: null,
    created_at: "2026-09-03T00:00:00Z", has_password: false, token: "tok",
  })));
  const qc = newClient();
  const spy = vi.spyOn(qc, "invalidateQueries");
  wrapModal(<CreateShareHarness itemId="i1" />, qc);
  await userEvent.click(screen.getByText("create"));
  await waitFor(() => {
    expect(spy).toHaveBeenCalledWith({ queryKey: ["shares", "i1"] });
    // Prefix-matches every ["children", spaceId, parentId] entry — the
    // component doesn't have spaceId/parentId to invalidate an exact key.
    expect(spy).toHaveBeenCalledWith({ queryKey: ["children"] });
  });
});

test("revoking a share link invalidates the children listing so the badge updates", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res(204, null)));
  const qc = newClient();
  const spy = vi.spyOn(qc, "invalidateQueries");
  wrapModal(<RevokeShareHarness itemId="i1" />, qc);
  await userEvent.click(screen.getByText("revoke"));
  await waitFor(() => {
    expect(spy).toHaveBeenCalledWith({ queryKey: ["shares", "i1"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["children"] });
  });
});
