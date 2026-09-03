// React Query hooks, grouped by feature as later tasks append to this file.
// Keep each task's hooks together with a comment banner; never rewrite
// another task's section wholesale.

import { useCallback, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import { isUnauthorized } from "./errors";
import type { Item, Space, User } from "./types";
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
