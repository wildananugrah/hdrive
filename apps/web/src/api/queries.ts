// React Query hooks, grouped by feature as later tasks append to this file.
// Keep each task's hooks together with a comment banner; never rewrite
// another task's section wholesale.

import { useCallback, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, API_BASE } from "./client";
import { isUnauthorized } from "./errors";
import type {
  Backend, CreatedShareLink, Grant, Group, Item, ProbeResult, ShareLink, Space, SpaceMember, Subject, User,
} from "./types";
import { uploadFile, type UploadPhase } from "./upload";

// ---- Auth (Task 4) ---------------------------------------------------

export function useMe() {
  return useQuery<User | null>({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        return await api.get<User>("/api/auth/me");
      } catch (e) {
        // Anonymous is a normal state, not an error the UI should surface.
        if (isUnauthorized(e)) return null;
        throw e;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { email: string; password: string }) =>
      api.post<{ user: User }>("/api/auth/login", v),
    onSuccess: (data) => qc.setQueryData(["me"], data.user),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<null>("/api/auth/logout"),
    onSuccess: () => { qc.setQueryData(["me"], null); qc.clear(); },
  });
}

// ---- Spaces (Task 5) ---------------------------------------------------

export function useSpaces() {
  return useQuery<Space[]>({ queryKey: ["spaces"], queryFn: () => api.get<Space[]>("/api/spaces") });
}

// ---- Files (Task 6) ---------------------------------------------------

export function useChildren(spaceId: string, parentId: string | null) {
  return useQuery<Item[]>({
    queryKey: ["children", spaceId, parentId],
    queryFn: () =>
      api.get<Item[]>(
        `/api/spaces/${spaceId}/children${parentId ? `?parent=${parentId}` : ""}`,
      ),
    enabled: Boolean(spaceId),
  });
}

// ---- Uploads (Task 7) ---------------------------------------------------

export type UploadState = {
  id: string; name: string; phase: UploadPhase; progress: number;
  itemId?: string; error?: string;
};

export function useUploads(spaceId: string, parentId: string | null) {
  const qc = useQueryClient();
  const [uploads, setUploads] = useState<UploadState[]>([]);
  // ponytail: File handles are kept here so retry() can re-send after a
  // failure, but nothing evicts a "done" entry until its toast is dismissed —
  // a long session with many uploads and no dismissals accumulates handles.
  // Upgrade: evict on phase "done" once the toast auto-dismisses, or cap the map.
  const files = useRef(new Map<string, File>());

  const patch = (id: string, next: Partial<UploadState>) =>
    setUploads((u) => u.map((x) => (x.id === id ? { ...x, ...next } : x)));

  const run = useCallback(async (id: string, file: File) => {
    try {
      const item = await uploadFile({
        spaceId, parentId, file,
        onPhase: (phase) => patch(id, { phase }),
        onProgress: (progress) => patch(id, { progress }),
      });
      patch(id, { itemId: item.id, error: undefined });
      qc.invalidateQueries({ queryKey: ["children", spaceId, parentId] });
    } catch (e) {
      patch(id, { phase: "failed", error: e instanceof Error ? e.message : "upload failed" });
    }
  }, [spaceId, parentId, qc]);

  const start = useCallback((incoming: FileList | File[]) => {
    for (const file of Array.from(incoming)) {
      const id = crypto.randomUUID();
      files.current.set(id, file);
      setUploads((u) => [...u, { id, name: file.name, phase: "reserving", progress: 0 }]);
      void run(id, file);
    }
  }, [run]);

  const retry = useCallback((id: string) => {
    const file = files.current.get(id);
    if (!file) return;
    patch(id, { phase: "reserving", progress: 0, error: undefined });
    void run(id, file);
  }, [run]);

  const dismiss = useCallback((id: string) => {
    files.current.delete(id);
    setUploads((u) => u.filter((x) => x.id !== id));
  }, []);

  return { uploads, start, retry, dismiss };
}

// ---- Item detail (Task 8) ------------------------------------------------

export function useItem(itemId: string) {
  return useQuery<Item>({
    queryKey: ["item", itemId],
    queryFn: () => api.get<Item>(`/api/items/${itemId}`),
    enabled: Boolean(itemId),
  });
}

/** attachment (download) by default; ?inline=1 for in-browser playback/viewing. */
export const contentUrl = (itemId: string, opts: { inline?: boolean } = {}) =>
  `${API_BASE}/api/items/${itemId}/content${opts.inline ? "?inline=1" : ""}`;

// ---- Item actions — rename, move, trash, restore (Task 9) -----------------

/**
 * Every non-deleted folder in the space, flat, with `path_ids` per folder —
 * the move picker's data source. `enabled` defaults to true but callers that
 * only need this while a move modal is open (the common case) should pass
 * `false` until then, so opening the space doesn't fire it eagerly.
 */
export function useSpaceFolders(spaceId: string, enabled = true) {
  return useQuery<Item[]>({
    queryKey: ["folders", spaceId],
    queryFn: () => api.get<Item[]>(`/api/spaces/${spaceId}/folders`),
    enabled: Boolean(spaceId) && enabled,
  });
}

export function useRenameItem(spaceId: string, parentId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; name: string }) =>
      api.patch<Item>(`/api/items/${v.id}`, { name: v.name }),
    // ["item", id] is what the detail route (useItem) reads — without this a
    // renamed item still shows its old name when opened, until something
    // else happens to invalidate it.
    onSuccess: (_data, v) => {
      qc.invalidateQueries({ queryKey: ["children", spaceId, parentId] });
      qc.invalidateQueries({ queryKey: ["item", v.id] });
    },
  });
}

export function useMoveItem(spaceId: string, _parentId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; parent_id: string | null }) =>
      api.patch<Item>(`/api/items/${v.id}`, { parent_id: v.parent_id }),
    // A move changes two folders' listings (source and destination), so
    // invalidate every children listing in the space rather than just one —
    // this key is a prefix of every ["children", spaceId, parentId] key.
    onSuccess: (_data, v) => {
      qc.invalidateQueries({ queryKey: ["children", spaceId] });
      qc.invalidateQueries({ queryKey: ["item", v.id] });
    },
  });
}

export function useDeleteItem(spaceId: string, parentId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<null>(`/api/items/${id}`),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ["children", spaceId, parentId] });
      qc.invalidateQueries({ queryKey: ["trash", spaceId] });
      qc.invalidateQueries({ queryKey: ["item", id] });
    },
  });
}

export function useRestoreItem(spaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<null>(`/api/items/${id}/restore`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["children", spaceId] });
      qc.invalidateQueries({ queryKey: ["trash", spaceId] });
    },
  });
}

export function useTrash(spaceId: string) {
  return useQuery<Item[]>({
    queryKey: ["trash", spaceId],
    queryFn: () => api.get<Item[]>(`/api/spaces/${spaceId}/trash`),
    enabled: Boolean(spaceId),
  });
}

// ---- Sharing (Task 10) ---------------------------------------------------
// listShares can NEVER return a raw token (the API only stores its SHA-256),
// so ShareLink has no `token` field — CreatedShareLink (token included) only
// ever comes back from the create mutation's response, once.

export function useShares(itemId: string) {
  return useQuery<ShareLink[]>({
    queryKey: ["shares", itemId],
    queryFn: () => api.get<ShareLink[]>(`/api/items/${itemId}/shares`),
    enabled: Boolean(itemId),
  });
}

export function useCreateShare(itemId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { mode: "view" | "download"; password?: string; expiresInDays?: number | null }) =>
      api.post<CreatedShareLink>(`/api/items/${itemId}/shares`, v),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shares", itemId] });
      // The children listing's has_live_share flag (VisibilityBadge) is a
      // separate cache from ["shares", itemId]; without this the row still
      // reads "Space" after creating a public link. ["children"] is a prefix
      // of every ["children", spaceId, parentId] key, so this doesn't need
      // spaceId/parentId threaded in here.
      qc.invalidateQueries({ queryKey: ["children"] });
    },
  });
}

export function useRevokeShare(itemId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (linkId: string) => api.del<null>(`/api/shares/${linkId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shares", itemId] });
      qc.invalidateQueries({ queryKey: ["children"] });
    },
  });
}

// ---- Permissions & admin (Task 11) ----------------------------------------
// listGroups/listGroupMembers ultimately require admin server-side (a plain
// space member calling GET /api/groups still 403s), but listBackends/
// listAdminUsers are requireAdmin outright — every list here can 403 on a
// forced URL even though the sidebar hides the link, so callers must branch
// on isError, not just isPending, per the state-branch requirement.

export const useGrants = (itemId: string) =>
  useQuery<Grant[]>({ queryKey: ["grants", itemId],
    queryFn: () => api.get<Grant[]>(`/api/items/${itemId}/grants`), enabled: Boolean(itemId) });

export function useGrantItem(itemId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { subject: Subject; role: "viewer" | "editor" | "owner" }) =>
      api.post<null>(`/api/items/${itemId}/grants`, v),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["grants", itemId] });
      // Same reasoning as useCreateShare: has_grants on the children listing
      // is a distinct cache entry that a grant/revoke doesn't otherwise touch.
      qc.invalidateQueries({ queryKey: ["children"] });
    },
  });
}

export function useRevokeGrant(itemId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (subject: Subject) => api.del<null>(`/api/items/${itemId}/grants`, { subject }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["grants", itemId] });
      qc.invalidateQueries({ queryKey: ["children"] });
    },
  });
}

export const useSpaceMembers = (spaceId: string) =>
  useQuery<SpaceMember[]>({ queryKey: ["spaceMembers", spaceId],
    queryFn: () => api.get<SpaceMember[]>(`/api/spaces/${spaceId}/members`), enabled: Boolean(spaceId) });

export const useGroups = () =>
  useQuery<Group[]>({ queryKey: ["groups"], queryFn: () => api.get<Group[]>("/api/groups") });

// Not in the original hook list handed down for this task — Groups.tsx needs
// a way to create groups and POST /api/groups already exists server-side
// (Task 1 only added the missing GET), so this is the natural extra hook.
export function useCreateGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.post<Group>("/api/groups", { name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["groups"] }),
  });
}

export const useAdminUsers = () =>
  useQuery<User[]>({ queryKey: ["adminUsers"], queryFn: () => api.get<User[]>("/api/admin/users") });

// register() takes no admin flag; promoting a new user is a second, separate
// PATCH, sent only when the caller checked the box — never unconditionally.
//
// The two calls are not equally required: once register() resolves, the
// account exists — a PATCH failure must not make the whole mutation reject
// as if nothing happened (that would hide the new account, skip the
// one-time password display, and invite a re-submit that just 409s on the
// email that already succeeded). Only register() failing rejects the
// mutation; a PATCH failure is caught and reported back via promoteFailed
// so the caller can still show the password and flag the partial result.
export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { name: string; email: string; password: string; isAdmin: boolean }) => {
      const user = await api.post<User>("/api/auth/register", {
        email: v.email, password: v.password, name: v.name,
      });
      let promoteFailed = false;
      if (v.isAdmin) {
        try {
          await api.patch(`/api/admin/users/${user.id}`, { is_admin: true });
        } catch {
          promoteFailed = true;
        }
      }
      return { user, promoteFailed };
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["adminUsers"] }); },
  });
}

export function useSetAdmin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; is_admin: boolean }) =>
      api.patch<User>(`/api/admin/users/${v.id}`, { is_admin: v.is_admin }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["adminUsers"] });
      // Demoting yourself (other admins remain, so no 409) must not leave
      // the sidebar and every admin route's guard still showing admin —
      // ["me"] is what they all read, and only this call knows it just changed.
      qc.invalidateQueries({ queryKey: ["me"] });
    },
  });
}

export const useBackends = () =>
  useQuery<Backend[]>({ queryKey: ["backends"], queryFn: () => api.get<Backend[]>("/api/admin/backends") });

export function useCreateBackend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { name: string; config: Record<string, unknown>; makeWriteTarget?: boolean }) =>
      api.post<Backend>("/api/admin/backends", v),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["backends"] }),
  });
}

export function useSetWriteTarget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<null>(`/api/admin/backends/${id}/write-target`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["backends"] }),
  });
}

export const useProbeBackend = () =>
  useMutation({ mutationFn: (id: string) => api.post<ProbeResult>(`/api/admin/backends/${id}/probe`) });

export function useDeleteBackend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<null>(`/api/admin/backends/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["backends"] }),
  });
}
