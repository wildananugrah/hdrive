import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import FileTable from "../src/components/FileTable";
import Files from "../src/routes/Files";
import type { Item } from "../src/api/types";

const item = (over: Partial<Item> = {}): Item => ({
  id: "i1", space_id: "s1", parent_id: null, kind: "file", name: "report.pdf",
  path_ids: ["i1"], size: 2048, mime: "application/pdf",
  storage_backend_id: "b1", storage_key: "s1/i1", status: "ready",
  deleted_at: null, created_by: "u1", created_at: "2026-09-01T00:00:00Z",
  has_grants: false, has_live_share: false, ...over,
});

const wrap = (ui: React.ReactNode, initial = "/") =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[initial]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );

afterEach(() => vi.unstubAllGlobals());

// ---- FileTable ----------------------------------------------------------

test("renders the mockup's column headers as uppercase mono labels", () => {
  wrap(<FileTable items={[item()]} spaceId="s1" spaceName="Studio" />);
  for (const h of ["NAME", "OWNER", "VISIBILITY", "SIZE", "MODIFIED"]) {
    expect(screen.getByText(h)).toBeInTheDocument();
  }
});

test("shows a formatted size and a folder shows none", () => {
  wrap(<FileTable items={[item(), item({ id: "i2", kind: "folder", name: "Docs", size: null })]}
                  spaceId="s1" spaceName="Studio" />);
  expect(screen.getByText("2.0 KB")).toBeInTheDocument();
  // The OWNER column is also "—" on every row, so a bare getByText("—") is
  // ambiguous here (multiple matches) — scope to the folder row's SIZE cell,
  // the 4th column (NAME, OWNER, VISIBILITY, SIZE, MODIFIED).
  const folderRow = screen.getByText("Docs").closest("tr")!;
  expect(folderRow.querySelectorAll("td")[3]).toHaveTextContent("—");
});

test("a folder row links into the folder; a file row links to the item", () => {
  wrap(<FileTable items={[item({ id: "f1", kind: "folder", name: "Docs" }), item()]}
                  spaceId="s1" spaceName="Studio" />);
  expect(screen.getByText("Docs").closest("a")).toHaveAttribute("href", "/s/s1/f/f1");
  expect(screen.getByText("report.pdf").closest("a")).toHaveAttribute("href", "/i/i1");
});

test("pending uploads are not listed as if they were ready", () => {
  wrap(<FileTable items={[item({ status: "pending", name: "half.txt" })]}
                  spaceId="s1" spaceName="Studio" />);
  expect(screen.getByText(/uploading/i)).toBeInTheDocument();
});

// /i/:id now exists (Task 8) and 409s on content for a pending item, so a
// pending row's name must not be a Link — only a ready row's name is.
test("a pending row's name is not a link; a ready row's name is", () => {
  wrap(
    <FileTable
      items={[item({ id: "i1", status: "pending", name: "half.txt" }), item({ id: "i2", name: "done.txt" })]}
      spaceId="s1"
      spaceName="Studio"
    />,
  );
  expect(screen.getByText("half.txt").closest("a")).toBeNull();
  expect(screen.getByText("done.txt").closest("a")).toHaveAttribute("href", "/i/i2");
});

test("an empty folder shows the empty state, not a bare table", () => {
  wrap(<FileTable items={[]} spaceId="s1" spaceName="Studio" />);
  expect(screen.getByText(/nothing here yet/i)).toBeInTheDocument();
  expect(screen.queryByText("NAME")).toBeNull();
});

test("a row's visibility badge is computed from has_grants/has_live_share, not hardcoded", () => {
  wrap(
    <FileTable
      items={[
        item({ id: "i1", name: "space-item" }),
        item({ id: "i2", name: "shared-item", has_grants: true }),
        item({ id: "i3", name: "public-item", has_live_share: true }),
      ]}
      spaceId="s1"
      spaceName="Studio"
    />,
  );
  expect(screen.getByText("Space")).toBeInTheDocument();
  expect(screen.getByText("Shared")).toBeInTheDocument();
  expect(screen.getByText("Public")).toBeInTheDocument();
});

// ---- RowMenu — FIX 4: Share/Manage access can't work on a folder or a
// non-ready item (the API 400s a folder share and a non-ready item share;
// grants need OWNER on a real item), so disable rather than hide, with a
// title explaining why. This is what predicate-break #3 targets.

test("Share and Manage access are disabled for a folder row, with a title explaining why", async () => {
  wrap(<FileTable items={[item({ id: "f1", kind: "folder", name: "Docs" })]} spaceId="s1" spaceName="Studio" />);
  await userEvent.click(screen.getByRole("button", { name: /item actions/i }));
  const share = screen.getByRole("menuitem", { name: /share/i });
  const manage = screen.getByRole("menuitem", { name: /manage access/i });
  expect(share).toBeDisabled();
  expect(manage).toBeDisabled();
  expect(share.getAttribute("title")).toBeTruthy();
  expect(manage.getAttribute("title")).toBeTruthy();
});

test("Share and Manage access are disabled for a pending (not-ready) item", async () => {
  wrap(<FileTable items={[item({ status: "pending" })]} spaceId="s1" spaceName="Studio" />);
  await userEvent.click(screen.getByRole("button", { name: /item actions/i }));
  expect(screen.getByRole("menuitem", { name: /share/i })).toBeDisabled();
  expect(screen.getByRole("menuitem", { name: /manage access/i })).toBeDisabled();
});

test("Share and Manage access stay enabled for a ready file", async () => {
  wrap(<FileTable items={[item()]} spaceId="s1" spaceName="Studio" />);
  await userEvent.click(screen.getByRole("button", { name: /item actions/i }));
  expect(screen.getByRole("menuitem", { name: /share/i })).toBeEnabled();
  expect(screen.getByRole("menuitem", { name: /manage access/i })).toBeEnabled();
});

// ---- Files route — must branch on isError explicitly, never treat a
// server fault as an empty folder (isPending is false on error too). --------

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const renderFiles = (initial = "/s/s1") =>
  wrap(
    <Routes>
      <Route path="/s/:spaceId" element={<Files />} />
      <Route path="/s/:spaceId/f/:itemId" element={<Files />} />
    </Routes>,
    initial,
  );

test("a 500 from /children renders an error state with Retry, not an empty folder", async () => {
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (String(url).endsWith("/api/spaces")) return Promise.resolve(jsonRes([{ id: "s1", name: "Studio", created_at: "2026-09-01T00:00:00Z" }]));
    return Promise.resolve(jsonRes({ error: "internal error" }, 500));
  }));
  renderFiles();
  expect(await screen.findByText(/something went wrong/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  expect(screen.queryByText(/nothing here yet/i)).toBeNull();
});

test("a 404 from /children renders not-found, never 'forbidden'", async () => {
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (String(url).endsWith("/api/spaces")) return Promise.resolve(jsonRes([{ id: "s1", name: "Studio", created_at: "2026-09-01T00:00:00Z" }]));
    return Promise.resolve(jsonRes({ error: "not found" }, 404));
  }));
  renderFiles();
  expect(await screen.findByText(/not found/i)).toBeInTheDocument();
  expect(screen.queryByText(/forbidden/i)).toBeNull();
});

test("a genuinely empty folder shows the empty state", async () => {
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (String(url).endsWith("/api/spaces")) return Promise.resolve(jsonRes([{ id: "s1", name: "Studio", created_at: "2026-09-01T00:00:00Z" }]));
    return Promise.resolve(jsonRes([]));
  }));
  renderFiles();
  expect(await screen.findByText(/nothing here yet/i)).toBeInTheDocument();
});
