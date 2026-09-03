import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import Sidebar from "../src/components/Sidebar";
import Settings from "../src/routes/Settings";
import SpaceRedirect from "../src/routes/SpaceRedirect";

const wrap = (ui: React.ReactNode, initial = "/s/space-1") =>
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
  expect(screen.getByText(/trash/i).closest("a")).toHaveAttribute("href", "/s/space-1/trash");
});

// --- SpaceRedirect: the "belongs to no spaces" case a fresh non-admin user
// hits on day one. This must render the empty state, not redirect to nowhere. ---

test("a user with no spaces sees an empty-state message and no redirect happens", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonRes([])));
  wrap(
    <Routes>
      <Route path="/" element={<SpaceRedirect />} />
      <Route path="/s/:spaceId" element={<div>space view</div>} />
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
      <Route path="/s/:spaceId" element={<div>space view</div>} />
    </Routes>,
    "/",
  );
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
