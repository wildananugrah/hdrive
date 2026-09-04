import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import SpaceRedirect from "../src/routes/SpaceRedirect";

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function SpaceView() {
  const { spaceId } = useParams();
  return <div>space view {spaceId}</div>;
}

const wrap = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<SpaceRedirect />} />
          <Route path="/space/:spaceId" element={<SpaceView />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

afterEach(() => vi.unstubAllGlobals());

test("the empty state offers to create a space, and creating one navigates to it", async () => {
  const spacesCalls: number[] = [];
  const fetchMock = vi.fn((url: string, opts?: RequestInit) => {
    const u = String(url);
    const method = opts?.method ?? "GET";
    if (u.endsWith("/api/spaces") && method === "GET") {
      spacesCalls.push(1);
      // Still empty on refetch — navigation must come from the mutation's
      // own response, not from the invalidated list resolving in time.
      return Promise.resolve(jsonRes([]));
    }
    if (u.endsWith("/api/spaces") && method === "POST") {
      expect(JSON.parse(opts!.body as string)).toEqual({ name: "Marketing" });
      return Promise.resolve(jsonRes({ id: "space-42", name: "Marketing", created_at: "2026-01-01" }));
    }
    throw new Error(`unexpected fetch: ${method} ${u}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  wrap();
  await userEvent.click(await screen.findByRole("button", { name: /create a space/i }));
  await userEvent.type(screen.getByLabelText(/name/i), "Marketing");
  await userEvent.click(screen.getByRole("button", { name: /^create space$/i }));

  expect(await screen.findByText("space view space-42")).toBeInTheDocument();
});

test("a 500 while loading spaces shows an error with Retry, not the empty state", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonRes({ error: "internal error" }, 500)));
  wrap();
  expect(await screen.findByRole("button", { name: /retry/i })).toBeInTheDocument();
  expect(screen.queryByText(/not a member of any space/i)).toBeNull();
  expect(screen.queryByRole("button", { name: /create a space/i })).toBeNull();
});

test("creating a space invalidates the spaces list", async () => {
  let spacesCallCount = 0;
  const fetchMock = vi.fn((url: string, opts?: RequestInit) => {
    const u = String(url);
    const method = opts?.method ?? "GET";
    if (u.endsWith("/api/spaces") && method === "GET") {
      spacesCallCount += 1;
      return Promise.resolve(jsonRes(spacesCallCount === 1 ? [] : [{ id: "space-42", name: "Marketing", created_at: "2026-01-01" }]));
    }
    if (u.endsWith("/api/spaces") && method === "POST") {
      return Promise.resolve(jsonRes({ id: "space-42", name: "Marketing", created_at: "2026-01-01" }));
    }
    throw new Error(`unexpected fetch: ${method} ${u}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  wrap();
  await userEvent.click(await screen.findByRole("button", { name: /create a space/i }));
  await userEvent.type(screen.getByLabelText(/name/i), "Marketing");
  await userEvent.click(screen.getByRole("button", { name: /^create space$/i }));

  await screen.findByText("space view space-42");
  // Once for the initial load, again because the mutation invalidated ["spaces"].
  expect(spacesCallCount).toBeGreaterThanOrEqual(2);
});

test("a whitespace-only space name cannot be submitted", async () => {
  const fetchMock = vi.fn((url: string, opts?: RequestInit) => {
    const u = String(url);
    const method = opts?.method ?? "GET";
    if (u.endsWith("/api/spaces") && method === "GET") return Promise.resolve(jsonRes([]));
    throw new Error(`unexpected fetch: ${method} ${u}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  wrap();
  await userEvent.click(await screen.findByRole("button", { name: /create a space/i }));
  const input = screen.getByLabelText(/name/i);
  await userEvent.type(input, "   ");
  const submit = screen.getByRole("button", { name: /^create space$/i });
  expect(submit).toBeDisabled();

  // Bypass the disabled-button UI affordance and fire the form's submit
  // event directly, the way a stray Enter-key implicit-submission would —
  // this is what actually proves the handler itself rejects whitespace,
  // not just that the button looks disabled.
  const form = input.closest("form")!;
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    // mutate() invokes the mutationFn (and thus fetch) on a later microtask,
    // not synchronously within the dispatch — without yielding here this
    // assertion would pass trivially before that call ever has a chance to
    // happen, regardless of whether the guard exists.
    await new Promise((r) => setTimeout(r, 0));
  });

  expect(fetchMock.mock.calls.some(([, opts]) => (opts as RequestInit | undefined)?.method === "POST")).toBe(false);
});

test("closing the create-space modal unmounts it, so a stale name does not persist into the next open", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonRes([])));
  wrap();

  await userEvent.click(await screen.findByRole("button", { name: /create a space/i }));
  await userEvent.type(screen.getByLabelText(/name/i), "Draft name");
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByLabelText(/name/i)).toBeNull();

  await userEvent.click(screen.getByRole("button", { name: /create a space/i }));
  expect(screen.getByLabelText(/name/i)).toHaveValue("");
});
