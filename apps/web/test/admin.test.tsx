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

// ---- Users: creating a new user --------------------------------------------

const fillUserForm = async (over: { name?: string; email?: string; password?: string; admin?: boolean } = {}) => {
  await userEvent.click(await screen.findByRole("button", { name: /^add user$/i }));
  await userEvent.type(screen.getByLabelText(/^name$/i), over.name ?? "New Person");
  await userEvent.type(screen.getByLabelText(/^email$/i), over.email ?? "new.person@example.com");
  if (over.password !== "") await userEvent.type(screen.getByLabelText(/^password$/i), over.password ?? "correct-horse-battery");
  if (over.admin) await userEvent.click(screen.getByRole("checkbox", { name: /administrator/i }));
  await userEvent.click(screen.getByRole("button", { name: /^create user$/i }));
};

test("creating a user posts register, then only PATCHes admin when checked", async () => {
  const calls: { url: string; method?: string }[] = [];
  const fetchMock = withMe((url, init) => {
    calls.push({ url: String(url), method: init?.method });
    if (String(url).includes("/auth/register")) return Promise.resolve(res(201, user({ id: "u9", is_admin: false })));
    return Promise.resolve(res(200, [user()]));
  });
  vi.stubGlobal("fetch", fetchMock);
  wrap(<Users />);
  await fillUserForm(); // Administrator left unchecked.
  await screen.findByText(/shown only once/i);
  const patchCalls = calls.filter((c) => c.method === "PATCH");
  expect(patchCalls).toHaveLength(0);
  expect(calls.some((c) => c.url.includes("/auth/register") && c.method === "POST")).toBe(true);
});

test("checking Administrator also promotes the new user via a second PATCH", async () => {
  const calls: { url: string; method?: string }[] = [];
  const fetchMock = withMe((url, init) => {
    calls.push({ url: String(url), method: init?.method });
    if (String(url).includes("/auth/register")) return Promise.resolve(res(201, user({ id: "u9", is_admin: false })));
    if (init?.method === "PATCH") return Promise.resolve(res(200, user({ id: "u9", is_admin: true })));
    return Promise.resolve(res(200, [user()]));
  });
  vi.stubGlobal("fetch", fetchMock);
  wrap(<Users />);
  await fillUserForm({ admin: true });
  await screen.findByText(/shown only once/i);
  const patchCalls = calls.filter((c) => c.method === "PATCH" && c.url.includes("/u9"));
  expect(patchCalls).toHaveLength(1);
});

// ---- Users: the two calls are not equally required -------------------------
// register() succeeding means the account exists; a PATCH failure after that
// must not make the mutation look like it never happened.

test("a register success with a failed promotion still shows the password, invalidates the list, and flags the account as unpromoted", async () => {
  const client = newClient();
  const invalidateSpy = vi.spyOn(client, "invalidateQueries");
  const fetchMock = withMe((url, init) => {
    if (String(url).includes("/auth/register")) return Promise.resolve(res(201, user({ id: "u9", is_admin: false })));
    if (init?.method === "PATCH") return Promise.resolve(res(500, { error: "internal error" }));
    return Promise.resolve(res(200, [user()]));
  });
  vi.stubGlobal("fetch", fetchMock);
  wrap(<Users />, client);
  await fillUserForm({ admin: true });
  expect(await screen.findByLabelText(/generated password/i)).toBeInTheDocument();
  expect(screen.getByText(/could not be made an administrator/i)).toBeInTheDocument();
  await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["adminUsers"] }));
});

test("a register failure still rejects the whole mutation — no password panel, no account implied", async () => {
  const fetchMock = withMe((url) => {
    if (String(url).includes("/auth/register")) return Promise.resolve(res(500, { error: "internal error" }));
    return Promise.resolve(res(200, [user()]));
  });
  vi.stubGlobal("fetch", fetchMock);
  wrap(<Users />);
  await fillUserForm();
  await screen.findByRole("alert");
  expect(screen.queryByLabelText(/generated password/i)).toBeNull();
  expect(screen.queryByText(/shown only once/i)).toBeNull();
});

test("a duplicate email shows the actionable conflict message, not a generic error", async () => {
  // Deliberately opaque server wording — proves the UI supplies the actionable
  // copy itself rather than echoing a mock body that already says it.
  const fetchMock = withMe((url) => {
    if (String(url).includes("/auth/register")) return Promise.resolve(res(409, { error: "conflict" }));
    return Promise.resolve(res(200, [user()]));
  });
  vi.stubGlobal("fetch", fetchMock);
  wrap(<Users />);
  await fillUserForm({ email: "taken@example.com" });
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(/taken@example\.com is already registered/i);
  expect(alert.textContent).not.toMatch(/^conflict$/i);
});

test("a password under 8 characters is refused client-side, without a network round trip", async () => {
  const fetchMock = withMe(() => Promise.resolve(res(200, [user()])));
  vi.stubGlobal("fetch", fetchMock);
  wrap(<Users />);
  await fillUserForm({ password: "short1" });
  expect(await screen.findByRole("alert")).toHaveTextContent(/at least 8 characters/i);
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/auth/register"))).toBe(false);
});

test("the created password is shown once and never reaches storage or the console", async () => {
  const password = "correct-horse-battery";
  const fetchMock = withMe((url) => {
    if (String(url).includes("/auth/register")) return Promise.resolve(res(201, user({ id: "u9", is_admin: false })));
    return Promise.resolve(res(200, [user()]));
  });
  vi.stubGlobal("fetch", fetchMock);
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    wrap(<Users />);
    await fillUserForm({ password });
    const shown = await screen.findByLabelText(/generated password/i);
    expect(shown).toHaveValue(password);

    // Never in a fetch URL (query string / path).
    for (const [url] of fetchMock.mock.calls) expect(String(url)).not.toContain(password);
    // Never in Web Storage.
    for (let i = 0; i < localStorage.length; i++) {
      expect(localStorage.getItem(localStorage.key(i)!)).not.toContain(password);
    }
    for (let i = 0; i < sessionStorage.length; i++) {
      expect(sessionStorage.getItem(sessionStorage.key(i)!)).not.toContain(password);
    }
    // Never logged.
    for (const spy of [logSpy, errorSpy, warnSpy]) {
      for (const call of spy.mock.calls) expect(call.join(" ")).not.toContain(password);
    }
  } finally {
    logSpy.mockRestore(); errorSpy.mockRestore(); warnSpy.mockRestore();
  }
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

// ---- Groups: membership management (a group is inert until it has members) -
// Members are chosen from GET /api/admin/users, a distinct admin-only endpoint.

const adminUser = (over: Partial<User> = {}): User => ({
  id: "u2", email: "mo@hdrive.test", name: "Mo Member", is_admin: false, ...over,
});

// Routes a group's own fetch mock by endpoint, letting each test only
// describe the endpoints it cares about. `state` is mutable so a test can
// change what later responses say (e.g. once a member has been added).
type GroupsFetchState = {
  members: unknown[]; membersStatus?: number; users: User[]; groups: Group[];
  onAdd?: (state: GroupsFetchState) => void;
  onRemove?: (state: GroupsFetchState, userId: string) => void;
};
const groupsFetch = (state: GroupsFetchState) =>
  withMe((url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/members") && init?.method === "POST") {
      state.onAdd?.(state);
      return Promise.resolve(res(204, null));
    }
    if (u.includes("/members") && init?.method === "DELETE") {
      const userId = JSON.parse((init.body as string) ?? "{}").user_id;
      state.onRemove?.(state, userId);
      return Promise.resolve(res(204, null));
    }
    if (u.includes("/members")) {
      return Promise.resolve(res(state.membersStatus ?? 200, state.members));
    }
    if (u.includes("/admin/users")) return Promise.resolve(res(200, state.users));
    return Promise.resolve(res(200, state.groups));
  });

test("expanding a group lists its members", async () => {
  vi.stubGlobal("fetch", groupsFetch({ members: [adminUser()], users: [adminUser()], groups: [group()] }));
  wrap(<Groups />);
  await screen.findByText("Editors");
  await userEvent.click(screen.getByRole("button", { name: /manage members/i }));
  expect(await screen.findByText("Mo Member")).toBeInTheDocument();
});

test("a server error loading a group's members shows a retry affordance, never an empty list", async () => {
  vi.stubGlobal("fetch", groupsFetch({ members: [], membersStatus: 500, users: [], groups: [group()] }));
  wrap(<Groups />);
  await screen.findByText("Editors");
  await userEvent.click(screen.getByRole("button", { name: /manage members/i }));
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  expect(screen.queryByText(/no members yet/i)).toBeNull();
});

test("adding a member updates member_count without a manual refresh", async () => {
  const state: GroupsFetchState = {
    members: [], users: [adminUser()], groups: [group({ member_count: 0 })],
    onAdd: (s) => { s.members = [adminUser()]; s.groups = [group({ member_count: 1 })]; },
  };
  vi.stubGlobal("fetch", groupsFetch(state));
  wrap(<Groups />);
  await screen.findByText("Editors");
  expect(screen.getByText(/0 members/i)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /manage members/i }));
  await screen.findByText(/no members yet/i);
  await userEvent.selectOptions(screen.getByLabelText(/add a member/i), "u2");
  await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
  // The count lives in a different cache (["groups"]) than the member list
  // (["groupMembers", id]) — both must be invalidated, or this stays "0
  // members" until an unrelated refetch happens to touch ["groups"].
  await waitFor(() => expect(screen.getByText(/1 member\b/i)).toBeInTheDocument());
});

test("removing a member updates member_count without a manual refresh", async () => {
  let removedUserId: string | undefined;
  const state: GroupsFetchState = {
    members: [adminUser()], users: [adminUser()], groups: [group({ member_count: 1 })],
    onRemove: (s, userId) => {
      removedUserId = userId;
      s.members = [];
      s.groups = [group({ member_count: 0 })];
    },
  };
  vi.stubGlobal("fetch", groupsFetch(state));
  wrap(<Groups />);
  await screen.findByText("Editors");
  expect(screen.getByText(/1 member\b/i)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /manage members/i }));
  await screen.findByText("Mo Member");
  await userEvent.click(screen.getByRole("button", { name: /remove/i }));

  // Mirrors the add-path test: the member list drops the row AND
  // member_count (a separate cache, ["groups"]) decrements without a manual
  // refresh — dropping either invalidation must fail one of these.
  // ("Mo Member" alone isn't distinctive enough once removed — a removed
  // member becomes a candidate again in the "Add a member" <option> list —
  // so the row's own Remove button and the empty-list copy are checked instead.)
  await waitFor(() => expect(screen.queryByRole("button", { name: /remove/i })).toBeNull());
  expect(screen.getByText(/no members yet/i)).toBeInTheDocument();
  await waitFor(() => expect(screen.getByText(/0 members/i)).toBeInTheDocument());
  expect(removedUserId).toBe("u2");
});
