import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import BackendRow from "../src/routes/admin/BackendRow";
import Backends from "../src/routes/admin/Backends";
import Groups from "../src/routes/admin/Groups";
import Users from "../src/routes/admin/Users";
import type { Backend, Group, ProbeResult, User } from "../src/api/types";

const newClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

const wrap = (ui: React.ReactNode, client = newClient()) =>
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );

const res = (status: number, body: unknown) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const backend = (over: Partial<Backend> = {}): Backend => ({
  id: "b1", name: "primary", provider: "s3", is_write_target: true,
  created_at: "2026-09-01T00:00:00Z", item_count: 3, ...over,
});

const adminMe = { id: "admin1", email: "admin@hdrive.test", name: "Admin", is_admin: true };

// Every screen here also calls useMe() for its own is_admin guard, so a flat
// mockResolvedValue answers /auth/me with whatever list body the test meant
// for a different endpoint. Route /auth/me to an admin explicitly and let
// everything else fall through to `rest`.
const withMe = (rest: (url: string, init?: RequestInit) => Promise<Response>, me: unknown = adminMe) =>
  vi.fn((url: string, init?: RequestInit) =>
    String(url).includes("/auth/me") ? Promise.resolve(res(200, me)) : rest(url, init));

afterEach(() => vi.unstubAllGlobals());

// ---- BackendRow (from the brief) -------------------------------------------

test("the write target is marked, and a non-target offers to become one", () => {
  const { unmount } = wrap(<BackendRow backend={backend()} />);
  expect(screen.getByText(/write target/i)).toBeInTheDocument();
  unmount();
  wrap(<BackendRow backend={backend({ is_write_target: false })} />);
  expect(screen.getByRole("button", { name: /make write target/i })).toBeInTheDocument();
});

test("a backend still holding files cannot be deleted", () => {
  wrap(<BackendRow backend={backend({ is_write_target: false, item_count: 3 })} />);
  const del = screen.getByRole("button", { name: /delete/i });
  expect(del).toBeDisabled();
  expect(del).toHaveAttribute("title", "This backend still holds files");
});

test("an empty backend can be deleted", () => {
  wrap(<BackendRow backend={backend({ is_write_target: false, item_count: 0 })} />);
  expect(screen.getByRole("button", { name: /delete/i })).toBeEnabled();
});

test("the probe shows every step, including which one failed and its detail", async () => {
  const result: ProbeResult = {
    ok: false,
    steps: [
      { step: "presign+put", ok: true },
      { step: "head", ok: false, detail: "object not found after a successful PUT" },
    ],
  };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res(200, result)));
  wrap(<BackendRow backend={backend()} />);
  await userEvent.click(screen.getByRole("button", { name: /test connection/i }));
  expect(await screen.findByText(/presign\+put/)).toBeInTheDocument();
  expect(screen.getByText("head")).toBeInTheDocument();
  expect(screen.getByText(/object not found after a successful PUT/i)).toBeInTheDocument();
});

// ---- A rejected mutation must not fail silently -----------------------------
// (review finding: probe/setWriteTarget had no isError branch — a thrown
// error looked identical to never having clicked the button.)

test("a probe that rejects (network error, 500, bad JSON) shows an error, distinct from a returned {ok:false}", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network error")));
  wrap(<BackendRow backend={backend()} />);
  await userEvent.click(screen.getByRole("button", { name: /test connection/i }));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(/could not run the probe/i);
});

test("a setWriteTarget that rejects shows an error instead of silently reverting", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res(500, { error: "internal error" })));
  wrap(<BackendRow backend={backend({ is_write_target: false })} />);
  await userEvent.click(screen.getByRole("button", { name: /make write target/i }));
  expect(await screen.findByRole("alert")).toBeInTheDocument();
});

// ---- Backends list: state-branch requirement -------------------------------

test("a server error loading backends shows a retry affordance, never an empty list", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res(500, { error: "internal error" })));
  wrap(<Backends />);
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  expect(screen.queryByText(/no storage backends/i)).toBeNull();
});

test("a non-admin forcing the URL sees Forbidden, not a broken screen or the list", async () => {
  const plain = { id: "u1", email: "a@b.com", name: "Plain", is_admin: false };
  vi.stubGlobal("fetch", vi.fn((url: string) =>
    Promise.resolve(String(url).includes("/auth/me") ? res(200, plain) : res(403, { error: "forbidden" })),
  ));
  wrap(<Backends />);
  expect(await screen.findByText(/forbidden/i)).toBeInTheDocument();
});

// ---- Credentials never reach the DOM (mirrors share.test.tsx's token guard) -

const fillBackendForm = async (secret: string) => {
  await userEvent.click(await screen.findByRole("button", { name: /^add backend$/i }));
  await userEvent.type(screen.getByLabelText(/^name$/i), "New backend");
  await userEvent.type(screen.getByLabelText(/endpoint/i), "https://s3.example.com");
  await userEvent.type(screen.getByLabelText(/bucket/i), "my-bucket");
  await userEvent.type(screen.getByLabelText(/access key id/i), "AKIAEXAMPLE");
  await userEvent.type(screen.getByLabelText(/secret access key/i), secret);
  await userEvent.click(screen.getByRole("button", { name: /^add backend$/i }));
};

test("a submitted secret never appears in the DOM after a successful create", async () => {
  const secret = "s3cr3t-VALUE-98213";
  vi.stubGlobal("fetch", withMe((_url, init) =>
    Promise.resolve(init?.method === "POST" ? res(201, backend({ id: "b9" })) : res(200, [])),
  ));
  wrap(<Backends />);
  await fillBackendForm(secret);
  // Success clears and closes the form.
  await waitFor(() => expect(screen.queryByLabelText(/secret access key/i)).toBeNull());
  expect(document.body.textContent).not.toContain(secret);
});

test("a submitted secret never appears in the DOM after a failed create (the likelier leak path)", async () => {
  const secret = "s3cr3t-VALUE-77104";
  vi.stubGlobal("fetch", withMe((_url, init) =>
    Promise.resolve(init?.method === "POST" ? res(400, { error: "config.endpoint must be an http(s) URL" }) : res(200, [])),
  ));
  wrap(<Backends />);
  await fillBackendForm(secret);
  await screen.findByRole("alert");
  expect(document.body.textContent).not.toContain(secret);
});

// ---- Users: the actionable last-admin 409 ----------------------------------

const user = (over: Partial<User> = {}): User => ({
  id: "u1", email: "admin@hdrive.test", name: "Ada Admin", is_admin: true, ...over,
});

test("demoting the last admin surfaces the actionable 409 message, not a generic failure", async () => {
  // Deliberately opaque server wording — the UI must supply the actionable
  // copy itself (isConflict → a written message), not merely echo whatever
  // string the server happened to send.
  const fetchMock = withMe((_url, init) => {
    if (init?.method === "PATCH") return Promise.resolve(res(409, { error: "conflict" }));
    return Promise.resolve(res(200, [user()]));
  });
  vi.stubGlobal("fetch", fetchMock);
  wrap(<Users />);
  await userEvent.click(await screen.findByRole("button", { name: /demote/i }));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(/cannot remove the last admin/i);
  // Not the raw/generic server message.
  expect(alert.textContent).not.toMatch(/^conflict$/i);
});

test("promoting a member succeeds and the row reflects the new state", async () => {
  const member = user({ id: "u2", name: "Mo Member", is_admin: false });
  let promoted = false;
  const fetchMock = withMe((_url, init) => {
    if (init?.method === "PATCH") { promoted = true; return Promise.resolve(res(200, { ...member, is_admin: true })); }
    return Promise.resolve(res(200, [{ ...member, is_admin: promoted }]));
  });
  vi.stubGlobal("fetch", fetchMock);
  wrap(<Users />);
  await userEvent.click(await screen.findByRole("button", { name: /promote/i }));
  await screen.findByRole("button", { name: /demote/i });
});

test("a successful demote invalidates [\"me\"], not just the admin list — so the sidebar/guards don't keep showing admin", async () => {
  const client = newClient();
  const invalidateSpy = vi.spyOn(client, "invalidateQueries");
  const fetchMock = withMe((_url, init) => {
    if (init?.method === "PATCH") return Promise.resolve(res(200, { ...user(), is_admin: false }));
    return Promise.resolve(res(200, [user()]));
  });
  vi.stubGlobal("fetch", fetchMock);
  wrap(<Users />, client);
  await userEvent.click(await screen.findByRole("button", { name: /demote/i }));
  await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["me"] }));
});

test("a server error loading users shows a retry affordance, never an empty list", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res(500, { error: "internal error" })));
  wrap(<Users />);
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  expect(screen.queryByText(/no users/i)).toBeNull();
});

// ---- Groups: list with member counts, create -------------------------------

const group = (over: Partial<Group> = {}): Group => ({
  id: "g1", name: "Editors", created_at: "2026-09-01T00:00:00Z", member_count: 4, ...over,
});

test("the groups list shows each group's member count", async () => {
  vi.stubGlobal("fetch", withMe(() => Promise.resolve(res(200, [group()]))));
  wrap(<Groups />);
  expect(await screen.findByText("Editors")).toBeInTheDocument();
  expect(screen.getByText(/4 members/i)).toBeInTheDocument();
});

test("creating a group posts the name and the new group appears in the list", async () => {
  const fetchMock = withMe((_url, init) => {
    if (init?.method === "POST") return Promise.resolve(res(201, group({ id: "g2", name: "Reviewers", member_count: 0 })));
    return Promise.resolve(
      res(200, (fetchMock as any).created ? [group(), group({ id: "g2", name: "Reviewers", member_count: 0 })] : [group()]),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  wrap(<Groups />);
  await screen.findByText("Editors");
  await userEvent.type(screen.getByLabelText(/new group/i), "Reviewers");
  (fetchMock as any).created = true;
  await userEvent.click(screen.getByRole("button", { name: /^create$/i }));
  expect(await screen.findByText("Reviewers")).toBeInTheDocument();
});

test("a server error loading groups shows a retry affordance, never an empty list", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res(500, { error: "internal error" })));
  wrap(<Groups />);
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  expect(screen.queryByText(/no groups yet/i)).toBeNull();
});
