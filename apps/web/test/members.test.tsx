import { act } from "react-dom/test-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import SpaceMembers from "../src/routes/SpaceMembers";
import type { SpaceMember, User } from "../src/api/types";

const newClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

const wrap = (client = newClient()) =>
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/space/s1/members"]}>
        <Routes>
          <Route path="/space/:spaceId/members" element={<SpaceMembers />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

const res = (status: number, body: unknown) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const me: User = { id: "u1", email: "owner@hdrive.test", name: "Ola Owner", is_admin: false };

const ownerMember = (over: Partial<SpaceMember> = {}): SpaceMember => ({
  subject_type: "user", subject_id: "u1", role: 3, name: "Ola Owner", email: "owner@hdrive.test", ...over,
});
const groupMember = (over: Partial<SpaceMember> = {}): SpaceMember => ({
  subject_type: "group", subject_id: "g1", role: 2, name: "Editors", email: null, ...over,
});

// Routes every fetch by which endpoint/method it hits, so each test only
// overrides the responses it cares about. /auth/me always answers `me`
// unless a test explicitly overrides it (the non-owner test).
const routeFetch = (opts: {
  meUser?: unknown; membersStatus?: number; members?: SpaceMember[];
  onAdd?: (init?: RequestInit) => void; addStatus?: number; addBody?: unknown;
  onDelete?: (init?: RequestInit) => void;
} = {}) =>
  vi.fn((url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/auth/me")) return Promise.resolve(res(200, opts.meUser ?? me));
    if (u.includes("/members") && init?.method === "POST") {
      opts.onAdd?.(init);
      return Promise.resolve(res(opts.addStatus ?? 204, opts.addBody ?? null));
    }
    if (u.includes("/members") && init?.method === "DELETE") {
      opts.onDelete?.(init);
      return Promise.resolve(res(204, null));
    }
    if (u.includes("/members")) return Promise.resolve(res(opts.membersStatus ?? 200, opts.members ?? []));
    return Promise.resolve(res(404, { error: "unhandled in test" }));
  });

afterEach(() => vi.unstubAllGlobals());

test("lists users and groups distinguishably", async () => {
  vi.stubGlobal("fetch", routeFetch({ members: [ownerMember(), groupMember()] }));
  wrap();
  expect(await screen.findByText("Ola Owner")).toBeInTheDocument();
  expect(screen.getByText("Editors")).toBeInTheDocument();
  expect(screen.getByText("Person")).toBeInTheDocument();
  expect(screen.getByText("Group")).toBeInTheDocument();
});

test("adding by email sends {email, role} and refreshes the list", async () => {
  const onAdd = vi.fn();
  const qc = newClient();
  const spy = vi.spyOn(qc, "invalidateQueries");
  vi.stubGlobal("fetch", routeFetch({ members: [ownerMember()], onAdd }));
  wrap(qc);
  await screen.findByText("Ola Owner");
  await userEvent.type(screen.getByLabelText(/add by email/i), "new@hdrive.test");
  await userEvent.selectOptions(screen.getByLabelText(/role to add/i), "editor");
  await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
  await waitFor(() => expect(onAdd).toHaveBeenCalled());
  const body = JSON.parse((onAdd.mock.calls[0][0] as RequestInit).body as string);
  expect(body).toEqual({ email: "new@hdrive.test", role: "editor" });
  await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: ["spaceMembers", "s1"] }));
});

test("an unknown email surfaces the 404 as 'no user with that email'", async () => {
  vi.stubGlobal("fetch", routeFetch({
    members: [ownerMember()], addStatus: 404, addBody: { error: "no user with that email" },
  }));
  wrap();
  await screen.findByText("Ola Owner");
  await userEvent.type(screen.getByLabelText(/add by email/i), "ghost@hdrive.test");
  await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
  expect(await screen.findByText("no user with that email")).toBeInTheDocument();
});

test("a non-owner sees an ownership-required state, not a broken screen", async () => {
  // 403 (a plain "no access" forbid) and 404 (the API's deliberate "no
  // access OR doesn't exist" response — see isNotFound) must both land here,
  // and neither may render the word "forbidden": doing so for the 404 case
  // would leak the existence the API is deliberately hiding.
  vi.stubGlobal("fetch", routeFetch({ membersStatus: 403 }));
  const { unmount } = wrap();
  expect(await screen.findByText(/you need to be an owner/i)).toBeInTheDocument();
  expect(screen.queryByText(/forbidden/i)).toBeNull();
  unmount();

  vi.stubGlobal("fetch", routeFetch({ membersStatus: 404 }));
  wrap();
  expect(await screen.findByText(/you need to be an owner/i)).toBeInTheDocument();
  expect(screen.queryByText(/forbidden/i)).toBeNull();
});

test("removing your own owner role warns before proceeding", async () => {
  const onDelete = vi.fn();
  vi.stubGlobal("fetch", routeFetch({ members: [ownerMember()], onDelete }));
  wrap();
  await screen.findByText("Ola Owner");
  await userEvent.click(screen.getByRole("button", { name: /remove/i }));

  // The trap: asserting "not called" before the async mutation path has had
  // a chance to run passes trivially whether or not the guard exists. Flush
  // a microtask inside act() so a missing confirmation would actually have
  // fired its DELETE by the time this assertion runs.
  await act(async () => { await Promise.resolve(); });
  expect(onDelete).not.toHaveBeenCalled();
  expect(screen.getByText(/locks you out of managing it/i)).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: /remove me/i }));
  await waitFor(() => expect(onDelete).toHaveBeenCalled());
});

// Two separate controls can lock you out — Remove (above) and demoting
// yourself via the role select (here). Both carry their own isSelfOwner
// guard, so each needs its own test — a passing Remove test says nothing
// about whether the select's guard exists.
test("demoting your own owner role via the select warns before proceeding", async () => {
  const onAdd = vi.fn();
  vi.stubGlobal("fetch", routeFetch({ members: [ownerMember()], onAdd }));
  wrap();
  await screen.findByText("Ola Owner");
  await userEvent.selectOptions(screen.getByLabelText(/role for ola owner/i), "editor");

  // Same trap as the Remove test: flush a microtask inside act() so a
  // missing guard's POST would actually have fired before this assertion.
  await act(async () => { await Promise.resolve(); });
  expect(onAdd).not.toHaveBeenCalled();
  expect(screen.getByText(/lose the ability to manage this space/i)).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: /change my role/i }));
  await waitFor(() => expect(onAdd).toHaveBeenCalled());
  const body = JSON.parse((onAdd.mock.calls[0][0] as RequestInit).body as string);
  expect(body).toEqual({ subject: { type: "user", id: "u1" }, role: "editor" });
});

test("a 500 renders an error with Retry, never an empty member list", async () => {
  vi.stubGlobal("fetch", routeFetch({ membersStatus: 500, members: [] }));
  wrap();
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  expect(screen.queryByText(/you need to be an owner/i)).toBeNull();
  expect(screen.queryByRole("listitem")).toBeNull();
});
