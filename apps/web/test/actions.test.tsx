import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import RenameCell from "../src/components/RenameCell";
import MoveModal from "../src/components/MoveModal";
import FileTable from "../src/components/FileTable";
import Trash from "../src/routes/Trash";
import { useDeleteItem, useMoveItem, useRenameItem } from "../src/api/queries";
import type { Item } from "../src/api/types";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const newClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

const wrap = (ui: React.ReactNode, client = newClient()) =>
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);

// FileTable renders <Link>s, so it needs a router context — the other
// components under test here (RenameCell, MoveModal, the mutation harnesses)
// don't.
const wrapWithRouter = (ui: React.ReactNode, client = newClient()) =>
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );

const folder = (id: string, name: string, path: string[]): Item => ({
  id, space_id: "s1", parent_id: null, kind: "folder", name, path_ids: path,
  size: null, mime: null, storage_backend_id: null, storage_key: null,
  status: "ready", deleted_at: null, created_by: "u1", created_at: "2026-09-01T00:00:00Z",
  has_grants: false, has_live_share: false,
});

const item = (over: Partial<Item> = {}): Item => ({
  id: "i1", space_id: "s1", parent_id: null, kind: "file", name: "notes.txt",
  path_ids: ["i1"], size: 100, mime: "text/plain", storage_backend_id: "b1",
  storage_key: "s1/i1", status: "ready", deleted_at: null, created_by: "u1",
  created_at: "2026-09-01T00:00:00Z", has_grants: false, has_live_share: false, ...over,
});

const jsonRes = (body: unknown, status = 200) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: body === null ? {} : { "content-type": "application/json" },
  });

afterEach(() => vi.unstubAllGlobals());

// ---- RenameCell (brief) ----------------------------------------------------

test("Enter commits a rename, Escape cancels it", async () => {
  const onCommit = vi.fn();
  wrap(<RenameCell name="notes.txt" onCommit={onCommit} onCancel={() => {}} error={null} />);
  const input = screen.getByRole("textbox");
  await userEvent.clear(input);
  await userEvent.type(input, "renamed.txt{Enter}");
  expect(onCommit).toHaveBeenCalledWith("renamed.txt");

  onCommit.mockClear();
  await userEvent.type(input, "{Escape}");
  expect(onCommit).not.toHaveBeenCalled();
});

test("a 409 name conflict is shown inline, not as a generic failure", () => {
  wrap(<RenameCell name="notes.txt" onCommit={() => {}} onCancel={() => {}}
                   error="an item with that name already exists here" />);
  expect(screen.getByRole("alert")).toHaveTextContent(/already exists/i);
});

// ---- MoveModal (brief) ------------------------------------------------------

test("the move picker disables the item's own subtree as a destination", () => {
  const a = folder("a", "A", ["a"]);
  const b = folder("b", "B", ["a", "b"]);   // descendant of A
  const c = folder("c", "C", ["c"]);        // unrelated
  wrap(<MoveModal item={a} folders={[a, b, c]} onMove={() => {}} onClose={() => {}} pending={false} />);

  expect(screen.getByRole("button", { name: /^C$/ })).toBeEnabled();
  expect(screen.getByRole("button", { name: /^A$/ })).toBeDisabled();  // itself
  expect(screen.getByRole("button", { name: /^B$/ })).toBeDisabled();  // its descendant
});

test("the move picker offers the space root", async () => {
  const a = folder("a", "A", ["a"]);
  const onMove = vi.fn();
  wrap(<MoveModal item={a} folders={[a]} onMove={onMove} onClose={() => {}} pending={false} />);
  await userEvent.click(screen.getByRole("button", { name: /space root/i }));
  await waitFor(() => expect(onMove).toHaveBeenCalledWith(null));
});

// ---- MoveModal — own loading/error states (not in the brief; added per the
// correction: it must never assume the folders list is already there). -------

test("the move picker shows a loading state instead of an empty list while folders are fetching", () => {
  const a = folder("a", "A", ["a"]);
  wrap(<MoveModal item={a} folders={[]} onMove={() => {}} onClose={() => {}} pending={false}
                  foldersPending />);
  expect(screen.getByText(/loading folders/i)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /space root/i })).toBeNull();
});

test("the move picker shows a retry affordance when the folder list fails to load", async () => {
  const a = folder("a", "A", ["a"]);
  const onRetryFolders = vi.fn();
  wrap(<MoveModal item={a} folders={[]} onMove={() => {}} onClose={() => {}} pending={false}
                  foldersError={new Error("boom")} onRetryFolders={onRetryFolders} />);
  expect(screen.getByRole("alert")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /retry/i }));
  expect(onRetryFolders).toHaveBeenCalled();
});

// ---- FileTable — rename 409 must render the actionable conflict message,
// not the server's raw text (this is what predicate-break #2 targets: the
// mapping from isConflict() to copy lives in FileTable, not RenameCell). -----

test("renaming into a taken name shows the actionable conflict message, not the raw server error", async () => {
  const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      return Promise.resolve(jsonRes({ error: "duplicate key value violates unique constraint" }, 409));
    }
    return Promise.resolve(jsonRes([]));
  });
  vi.stubGlobal("fetch", fetchMock);

  wrapWithRouter(<FileTable items={[item()]} spaceId="s1" spaceName="Studio" parentId={null} />);
  await userEvent.click(screen.getByRole("button", { name: /item actions/i }));
  await userEvent.click(screen.getByRole("menuitem", { name: /rename/i }));
  const input = screen.getByRole("textbox", { name: /new name/i });
  await userEvent.clear(input);
  await userEvent.type(input, "taken.txt{Enter}");

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(/already exists/i);
  expect(alert).not.toHaveTextContent(/duplicate key/i);
});

test("committing the same name is a no-op — no PATCH is sent", async () => {
  const fetchMock = vi.fn(() => Promise.resolve(jsonRes([])));
  vi.stubGlobal("fetch", fetchMock);
  wrapWithRouter(<FileTable items={[item({ name: "notes.txt" })]} spaceId="s1" spaceName="Studio" parentId={null} />);
  await userEvent.click(screen.getByRole("button", { name: /item actions/i }));
  await userEvent.click(screen.getByRole("menuitem", { name: /rename/i }));
  await userEvent.type(screen.getByRole("textbox", { name: /new name/i }), "{Enter}");
  expect(fetchMock).not.toHaveBeenCalled();
  expect(screen.getByText("notes.txt")).toBeInTheDocument();
});

// ---- Cache invalidation — the exact keys useChildren()/useTrash() use. -----
// This is what predicate-break #4 targets: a near-miss key here leaves the
// table looking stale even though the request succeeded.

function DeleteHarness() {
  const del = useDeleteItem("s1", "p1");
  return <button onClick={() => del.mutate("i1")}>delete</button>;
}

test("deleting an item invalidates its own folder's children AND the trash — exact useChildren/useTrash keys", async () => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonRes(null, 204))));
  const qc = newClient();
  const spy = vi.spyOn(qc, "invalidateQueries");
  wrap(<DeleteHarness />, qc);
  await userEvent.click(screen.getByText("delete"));
  await waitFor(() => {
    expect(spy).toHaveBeenCalledWith({ queryKey: ["children", "s1", "p1"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["trash", "s1"] });
  });
});

function MoveHarness() {
  const move = useMoveItem("s1", "p1");
  return <button onClick={() => move.mutate({ id: "i1", parent_id: "p2" })}>move</button>;
}

test("moving an item invalidates every children listing in the space, not just the source folder", async () => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonRes(item()))));
  const qc = newClient();
  const spy = vi.spyOn(qc, "invalidateQueries");
  wrap(<MoveHarness />, qc);
  await userEvent.click(screen.getByText("move"));
  await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: ["children", "s1"] }));
});

function RenameHarness() {
  const rename = useRenameItem("s1", "p1");
  return <button onClick={() => rename.mutate({ id: "i1", name: "renamed.txt" })}>rename</button>;
}

// FIX 5: useItem's detail route reads ["item", itemId]; without this
// invalidation a renamed item still shows its old name when opened directly.
test("renaming an item invalidates its detail cache — the exact useItem key", async () => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonRes(item({ name: "renamed.txt" })))));
  const qc = newClient();
  const spy = vi.spyOn(qc, "invalidateQueries");
  wrap(<RenameHarness />, qc);
  await userEvent.click(screen.getByText("rename"));
  await waitFor(() => {
    expect(spy).toHaveBeenCalledWith({ queryKey: ["children", "s1", "p1"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["item", "i1"] });
  });
});

// ---- Trash route ------------------------------------------------------------

const renderTrash = () =>
  wrap(
    <MemoryRouter initialEntries={["/space/s1/trash"]}>
      <Routes><Route path="/space/:spaceId/trash" element={<Trash />} /></Routes>
    </MemoryRouter>,
  );

test("a 500 from the trash listing renders an error state with Retry, never 'trash is empty'", async () => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonRes({ error: "internal error" }, 500))));
  renderTrash();
  expect(await screen.findByText(/something went wrong/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  expect(screen.queryByText(/trash is empty/i)).toBeNull();
});

test("a genuinely empty trash shows the empty state", async () => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonRes([]))));
  renderTrash();
  expect(await screen.findByText(/trash is empty/i)).toBeInTheDocument();
});

test("restoring into a reused name shows an actionable message, not a generic one", async () => {
  const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
    if (init?.method === "POST") return Promise.resolve(jsonRes({ error: "conflict" }, 409));
    return Promise.resolve(jsonRes([
      { id: "t1", space_id: "s1", parent_id: null, kind: "file", name: "notes.txt",
        path_ids: ["t1"], size: 10, mime: "text/plain", storage_backend_id: "b1",
        storage_key: "s1/t1", status: "ready", deleted_at: "2026-09-02T00:00:00Z",
        created_by: "u1", created_at: "2026-09-01T00:00:00Z", has_grants: false, has_live_share: false },
    ]));
  });
  vi.stubGlobal("fetch", fetchMock);
  renderTrash();
  await userEvent.click(await screen.findByRole("button", { name: /restore/i }));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(/rename it/i);
  expect(alert).not.toHaveTextContent(/^conflict$/i);
});

// Sanity check that within() import above is used (row-scoped queries in a
// larger table); keeps the FileTable rename test resilient to more rows.
test("RowMenu targets the correct row when more than one item is present", async () => {
  const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") return Promise.resolve(jsonRes(item({ name: "second-renamed.txt" })));
    return Promise.resolve(jsonRes([]));
  });
  vi.stubGlobal("fetch", fetchMock);
  wrapWithRouter(
    <FileTable
      items={[item({ id: "i1", name: "first.txt" }), item({ id: "i2", name: "second.txt" })]}
      spaceId="s1" spaceName="Studio" parentId={null}
    />,
  );
  const secondRow = screen.getByText("second.txt").closest("tr")!;
  await userEvent.click(within(secondRow).getByRole("button", { name: /item actions/i }));
  await userEvent.click(within(secondRow).getByRole("menuitem", { name: /rename/i }));
  const input = screen.getByRole("textbox", { name: /new name/i });
  await userEvent.clear(input);
  await userEvent.type(input, "second-renamed.txt{Enter}");
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  const [, init] = fetchMock.mock.calls.find(([, i]) => i?.method === "PATCH")!;
  expect(JSON.parse(init!.body as string)).toEqual({ name: "second-renamed.txt" });
});
