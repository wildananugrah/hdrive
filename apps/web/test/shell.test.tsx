import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import AppShell from "../src/routes/AppShell";
import Sidebar from "../src/components/Sidebar";
import StorageMeter from "../src/components/StorageMeter";
import Settings from "../src/routes/Settings";
import SpaceRedirect from "../src/routes/SpaceRedirect";

const wrap = (ui: React.ReactNode, initial = "/space/space-1") =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[initial]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );

const admin = { id: "u1", email: "a@b.com", name: "Ada Lovelace", is_admin: true };
const plain = { ...admin, is_admin: false };

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

test("the sidebar shows the mockup's nav sections", () => {
  wrap(<Sidebar me={plain as any} spaceId="space-1" />);
  for (const label of [/my files/i, /shared/i, /recent/i, /trash/i]) {
    expect(screen.getByText(label)).toBeInTheDocument();
  }
});

test("admin navigation is hidden from non-admins and shown to admins", () => {
  const { unmount } = wrap(<Sidebar me={plain as any} spaceId="space-1" />);
  expect(screen.queryByText(/storage backends/i)).toBeNull();
  unmount();

  wrap(<Sidebar me={admin as any} spaceId="space-1" />);
  expect(screen.getByText(/storage backends/i)).toBeInTheDocument();
});

test("nav links point at the current space", () => {
  wrap(<Sidebar me={plain as any} spaceId="space-1" />);
  expect(screen.getByText(/my files/i).closest("a")).toHaveAttribute("href", "/space/space-1");
  expect(screen.getByText(/shared/i).closest("a")).toHaveAttribute("href", "/space/space-1?vis=shared");
  expect(screen.getByText(/recent/i).closest("a")).toHaveAttribute("href", "/space/space-1?sort=modified");
  expect(screen.getByText(/trash/i).closest("a")).toHaveAttribute("href", "/space/space-1/trash");
});

test("the space-scoped nav group is omitted (not emitted with a broken href) when there is no space id", () => {
  wrap(<Sidebar me={plain as any} spaceId={undefined} />);
  expect(screen.queryByText(/my files/i)).toBeNull();
  expect(screen.queryByText(/trash/i)).toBeNull();
});

// --- SpaceRedirect: the "belongs to no spaces" case a fresh non-admin user
// hits on day one. This must render the empty state, not redirect to nowhere. ---

test("a user with no spaces sees an empty-state message and no redirect happens", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonRes([])));
  wrap(
    <Routes>
      <Route path="/" element={<SpaceRedirect />} />
      <Route path="/space/:spaceId" element={<div>space view</div>} />
    </Routes>,
    "/",
  );
  expect(await screen.findByText(/not a member of any space/i)).toBeInTheDocument();
  expect(screen.queryByText("space view")).toBeNull();
});

test("a user with spaces is redirected to the first one", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    jsonRes([{ id: "space-9", name: "Nine", created_at: "2026-01-01" }]),
  ));
  wrap(
    <Routes>
      <Route path="/" element={<SpaceRedirect />} />
      <Route path="/space/:spaceId" element={<div>space view</div>} />
    </Routes>,
    "/",
  );
  expect(await screen.findByText("space view")).toBeInTheDocument();
});

// A 500 from /api/spaces must read as a server fault, not "you have no
// spaces" — isPending goes false on error just as it does on success with
// an empty array, so this is a distinct branch, not a subset of the empty case.
test("a server error loading spaces shows a retry affordance and does not claim the user has no spaces", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    jsonRes({ error: "internal error" }, 500),
  ));
  wrap(
    <Routes>
      <Route path="/" element={<SpaceRedirect />} />
      <Route path="/space/:spaceId" element={<div>space view</div>} />
    </Routes>,
    "/",
  );
  expect(await screen.findByRole("button", { name: /retry/i })).toBeInTheDocument();
  expect(screen.queryByText(/not a member of any space/i)).toBeNull();
  expect(screen.queryByText("space view")).toBeNull();
});

test("retrying after a spaces error succeeds and redirects", async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonRes({ error: "internal error" }, 500))
    .mockResolvedValueOnce(jsonRes([{ id: "space-9", name: "Nine", created_at: "2026-01-01" }]));
  vi.stubGlobal("fetch", fetchMock);
  wrap(
    <Routes>
      <Route path="/" element={<SpaceRedirect />} />
      <Route path="/space/:spaceId" element={<div>space view</div>} />
    </Routes>,
    "/",
  );
  await userEvent.click(await screen.findByRole("button", { name: /retry/i }));
  expect(await screen.findByText("space view")).toBeInTheDocument();
});

// --- Settings: identity + sign-out only, no fields the API can't save ---

test("settings shows the signed-in identity and offers sign-out, with no editable name or email field", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonRes(plain)));
  wrap(<Settings />, "/settings");
  expect(await screen.findByText(plain.name)).toBeInTheDocument();
  expect(screen.getByText(plain.email)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /log out/i })).toBeInTheDocument();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
});

test("settings marks an admin's identity with an Administrator badge", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonRes(admin)));
  wrap(<Settings />, "/settings");
  expect(await screen.findByText("Administrator")).toBeInTheDocument();
});

// --- AppShell: routes with no :spaceId segment must still get a real space
// id for the sidebar's space-scoped links, not a dead "/space/" href. ---

const meAndSpacesFetch = (spaces: unknown[]) =>
  vi.fn((url: string) => Promise.resolve(
    String(url).includes("/api/spaces") ? jsonRes(spaces) : jsonRes(plain),
  ));

test("on a route with no :spaceId (e.g. /settings), the shell resolves the sidebar links to the user's first space", async () => {
  vi.stubGlobal("fetch", meAndSpacesFetch([{ id: "space-7", name: "Seven", created_at: "2026-01-01" }]));
  wrap(
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/settings" element={<div>settings page</div>} />
      </Route>
    </Routes>,
    "/settings",
  );
  expect(await screen.findByText("settings page")).toBeInTheDocument();
  expect(screen.getByText(/trash/i).closest("a")).toHaveAttribute("href", "/space/space-7/trash");
});

test("on a route with no :spaceId, a user with no spaces at all gets no space-scoped nav group (no broken hrefs)", async () => {
  vi.stubGlobal("fetch", meAndSpacesFetch([]));
  wrap(
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/settings" element={<div>settings page</div>} />
      </Route>
    </Routes>,
    "/settings",
  );
  expect(await screen.findByText("settings page")).toBeInTheDocument();
  expect(screen.queryByText(/my files/i)).toBeNull();
});

// --- StorageMeter: there is deliberately no quota anywhere in this system —
// a bar or percentage would imply a ceiling that does not exist, and "0 B"
// on a failed request would misstate the user's actual usage. ---

test("the meter shows bytes used with no bar and no percentage", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonRes({ bytes: 5_500_000, items: 12 })));
  wrap(<StorageMeter spaceId="space-1" />);
  expect(await screen.findByText(/5\.2 MB used/i)).toBeInTheDocument();
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(document.body.textContent).not.toMatch(/%/);
});

test("a 500 from usage hides the meter rather than showing 0 B", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonRes({ error: "internal error" }, 500)));
  render(
    <QueryClientProvider client={client}>
      <StorageMeter spaceId="space-1" />
    </QueryClientProvider>,
  );
  // Wait for the query to actually settle into its error state before
  // asserting nothing rendered — checking "no 0 B" immediately would pass
  // trivially while the query is still pending (which also renders
  // nothing), regardless of whether the isError guard exists.
  await waitFor(() => expect(client.getQueryState(["spaceUsage", "space-1"])?.status).toBe("error"));
  expect(screen.queryByText(/0 B/i)).toBeNull();
  expect(document.body.textContent?.trim()).toBe("");
});
