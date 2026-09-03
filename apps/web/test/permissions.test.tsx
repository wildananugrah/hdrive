import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import PermissionsModal from "../src/components/PermissionsModal";
import type { Grant, Group, Item, SpaceMember } from "../src/api/types";

const newClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

const wrap = (ui: React.ReactNode, client = newClient()) =>
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);

const res = (status: number, body: unknown) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const item = (over: Partial<Item> = {}): Item => ({
  id: "i1", space_id: "s1", parent_id: null, kind: "file", name: "budget.xlsx",
  path_ids: ["i1"], size: 2048, mime: "application/vnd.ms-excel", storage_backend_id: "b1",
  storage_key: "s1/i1", status: "ready", deleted_at: null, created_by: "u1",
  created_at: "2026-09-01T00:00:00Z", has_grants: true, has_live_share: false, ...over,
});

const member = (over: Partial<SpaceMember> = {}): SpaceMember => ({
  subject_type: "user", subject_id: "u2", role: 2, name: "Mo Member", email: "mo@hdrive.test", ...over,
});

const group = (over: Partial<Group> = {}): Group => ({
  id: "g1", name: "Editors", created_at: "2026-09-01T00:00:00Z", member_count: 3, ...over,
});

const grant = (over: Partial<Grant> = {}): Grant => ({
  subject_type: "user", subject_id: "u2", role: 2, ...over,
});

// Routes every fetch by which endpoint it hits, so each test only needs to
// override the responses it cares about.
const routeFetch = (opts: {
  grants?: Grant[]; members?: SpaceMember[]; groups?: Group[]; groupsStatus?: number;
  onGrant?: (init?: RequestInit) => void;
} = {}) =>
  vi.fn((url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/grants") && init?.method === "POST") {
      opts.onGrant?.(init);
      return Promise.resolve(res(204, null));
    }
    if (u.endsWith("/grants") && init?.method === "DELETE") return Promise.resolve(res(204, null));
    if (u.includes("/grants")) return Promise.resolve(res(200, opts.grants ?? []));
    if (u.includes("/members")) return Promise.resolve(res(200, opts.members ?? []));
    if (u.endsWith("/api/groups")) return Promise.resolve(res(opts.groupsStatus ?? 200, opts.groups ?? []));
    return Promise.resolve(res(404, { error: "unhandled in test" }));
  });

afterEach(() => vi.unstubAllGlobals());

// ---- People tab -------------------------------------------------------------

test("the People tab lists existing user grants with a role select and Remove", async () => {
  vi.stubGlobal("fetch", routeFetch({ grants: [grant()], members: [member()] }));
  wrap(<PermissionsModal item={item()} onClose={() => {}} />);
  expect(await screen.findByText("Mo Member")).toBeInTheDocument();
  expect(screen.getByLabelText(/role for mo member/i)).toHaveValue("editor");
  expect(screen.getByRole("button", { name: /remove/i })).toBeInTheDocument();
});

test("adding a person posts a user grant with the chosen role", async () => {
  const onGrant = vi.fn();
  vi.stubGlobal("fetch", routeFetch({ grants: [], members: [member()], onGrant }));
  wrap(<PermissionsModal item={item()} onClose={() => {}} />);
  await screen.findByText(/no people have direct access/i);
  await userEvent.selectOptions(screen.getByLabelText(/person to add/i), "u2");
  await userEvent.selectOptions(screen.getByLabelText(/role to add/i), "viewer");
  await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
  expect(onGrant).toHaveBeenCalled();
  const body = JSON.parse((onGrant.mock.calls[0][0] as RequestInit).body as string);
  expect(body).toEqual({ subject: { type: "user", id: "u2" }, role: "viewer" });
});

// ---- Groups tab: the half the mockup never had -------------------------------

test("the Groups tab lists existing group grants, populated from useGroups()", async () => {
  vi.stubGlobal("fetch", routeFetch({ grants: [grant({ subject_type: "group", subject_id: "g1", role: 1 })], groups: [group()] }));
  wrap(<PermissionsModal item={item()} onClose={() => {}} />);
  await userEvent.click(screen.getByRole("tab", { name: /groups/i }));
  expect(await screen.findByText("Editors")).toBeInTheDocument();
  expect(screen.getByLabelText(/role for editors/i)).toHaveValue("viewer");
});

test("adding a group posts a group grant with the chosen role", async () => {
  const onGrant = vi.fn();
  vi.stubGlobal("fetch", routeFetch({ grants: [], groups: [group()], onGrant }));
  wrap(<PermissionsModal item={item()} onClose={() => {}} />);
  await userEvent.click(screen.getByRole("tab", { name: /groups/i }));
  await screen.findByText(/no groups have direct access/i);
  await userEvent.selectOptions(screen.getByLabelText(/group to add/i), "g1");
  await userEvent.selectOptions(screen.getByLabelText(/role to add/i), "owner");
  await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
  expect(onGrant).toHaveBeenCalled();
  const body = JSON.parse((onGrant.mock.calls[0][0] as RequestInit).body as string);
  expect(body).toEqual({ subject: { type: "group", id: "g1" }, role: "owner" });
});

test("a non-admin owner sees an actionable message, not a generic retry, when the group list 403s", async () => {
  vi.stubGlobal("fetch", routeFetch({ grants: [], groupsStatus: 403 }));
  wrap(<PermissionsModal item={item()} onClose={() => {}} />);
  await userEvent.click(screen.getByRole("tab", { name: /groups/i }));
  expect(await screen.findByText(/only administrators can grant access to groups/i)).toBeInTheDocument();
});

// ---- State-branch requirement: the grants list itself ------------------------

test("a 500 loading grants shows a retry affordance, never 'no access'", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res(500, { error: "internal error" })));
  wrap(<PermissionsModal item={item()} onClose={() => {}} />);
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  expect(screen.queryByText(/no people have/i)).toBeNull();
});
