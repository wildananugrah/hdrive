// React Query hooks, grouped by feature as later tasks append to this file.
// Keep each task's hooks together with a comment banner; never rewrite
// another task's section wholesale.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import { isUnauthorized } from "./errors";
import type { User } from "./types";

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
