import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import VideoPlayer from "../src/components/VideoPlayer";
import Item from "../src/routes/Item";
import { contentUrl } from "../src/api/queries";
import type { Item as ItemType } from "../src/api/types";

const wrap = (ui: React.ReactNode, initial = "/") =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[initial]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );

afterEach(() => vi.unstubAllGlobals());

// ---- contentUrl -----------------------------------------------------------

test("contentUrl targets the API and can request inline disposition", () => {
  expect(contentUrl("i1")).toMatch(/\/api\/items\/i1\/content$/);
  expect(contentUrl("i1", { inline: true })).toMatch(/\?inline=1$/);
});

// ---- VideoPlayer ------------------------------------------------------------

test("the video element streams inline and sends credentials", () => {
  wrap(<VideoPlayer itemId="i1" name="clip.mp4" />);
  const v = screen.getByTestId("video") as HTMLVideoElement;
  expect(v.getAttribute("src")).toContain("inline=1");
  expect(v.getAttribute("crossorigin")).toBe("use-credentials");
  expect(v).toHaveAttribute("controls");
  // preload=metadata lets the browser fetch the duration (and thus enable the
  // scrub bar) with a Range request instead of pulling the whole file.
  expect(v.getAttribute("preload")).toBe("metadata");
});

test("the download link uses attachment disposition, not inline", () => {
  wrap(<VideoPlayer itemId="i1" name="clip.mp4" />);
  const a = screen.getByRole("link", { name: /download/i });
  expect(a.getAttribute("href")).not.toContain("inline=1");
});

// ---- Item route -------------------------------------------------------------

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const itemFixture = (over: Partial<ItemType> = {}): ItemType => ({
  id: "i1", space_id: "s1", parent_id: null, kind: "file", name: "clip.mp4",
  path_ids: ["i1"], size: 2048, mime: "video/mp4",
  storage_backend_id: "b1", storage_key: "s1/i1", status: "ready",
  deleted_at: null, created_by: "u1", created_at: "2026-09-01T00:00:00Z",
  has_grants: false, has_live_share: false, ...over,
});

const renderItem = (initial = "/i/i1") =>
  wrap(
    <Routes>
      <Route path="/i/:itemId" element={<Item />} />
    </Routes>,
    initial,
  );

const stubFetch = (body: unknown, status = 200) =>
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonRes(body, status))));

test("a ready video item renders the video player", async () => {
  stubFetch(itemFixture());
  renderItem();
  expect(await screen.findByTestId("video")).toBeInTheDocument();
});

test("a ready non-video item renders a plain download link, no player", async () => {
  stubFetch(itemFixture({ mime: "application/pdf", name: "report.pdf" }));
  renderItem();
  const a = await screen.findByRole("link", { name: /download/i });
  expect(a).toHaveAttribute("href", contentUrl("i1"));
  expect(screen.queryByTestId("video")).toBeNull();
});

test("a pending item (still uploading) shows an uploading state, not a player or 409", async () => {
  stubFetch(itemFixture({ status: "pending" }));
  renderItem();
  expect(await screen.findByText(/still uploading/i)).toBeInTheDocument();
  expect(screen.queryByTestId("video")).toBeNull();
});

test("a 404 renders not-found, never 'forbidden' (404 also covers no-access)", async () => {
  stubFetch({ error: "not found" }, 404);
  renderItem();
  expect(await screen.findByText(/not found/i)).toBeInTheDocument();
  expect(screen.queryByText(/forbidden/i)).toBeNull();
});

test("a non-404 error renders an error state with Retry that calls refetch", async () => {
  const fetchMock = vi.fn(() => Promise.resolve(jsonRes({ error: "internal error" }, 500)));
  vi.stubGlobal("fetch", fetchMock);
  renderItem();
  expect(await screen.findByText(/something went wrong/i)).toBeInTheDocument();
  const before = fetchMock.mock.calls.length;
  screen.getByRole("button", { name: /retry/i }).click();
  expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
});
