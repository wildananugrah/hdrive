export const VIEWER = 1, EDITOR = 2, OWNER = 3;
export type Role = 1 | 2 | 3;

export type User = { id: string; email: string; name: string; is_admin: boolean };
export type Space = { id: string; name: string; created_at: string };

export type Item = {
  id: string;
  space_id: string;
  parent_id: string | null;
  kind: "folder" | "file";
  name: string;
  path_ids: string[];
  size: number | null;
  mime: string | null;
  storage_backend_id: string | null;
  storage_key: string | null;
  status: "pending" | "ready";
  deleted_at: string | null;
  created_by: string;
  created_at: string;
};

export type Subject = { type: "user" | "group"; id: string };
export type Grant = { subject_type: "user" | "group"; subject_id: string; role: Role };

export type SpaceMember = {
  subject_type: "user" | "group";
  subject_id: string;
  role: Role;
  name: string;
  email: string | null;
};

export type Group = { id: string; name: string; created_at: string; member_count: number };

export type ShareLink = {
  id: string;
  mode: "view" | "download";
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
  has_password: boolean;
};
/** Returned ONCE at creation; the raw token is never retrievable again. */
export type CreatedShareLink = ShareLink & { token: string };

export type Backend = {
  id: string; name: string; provider: string;
  is_write_target: boolean; created_at: string; item_count: number;
};
export type ProbeStep = { step: string; ok: boolean; detail?: string };
export type ProbeResult = { ok: boolean; steps: ProbeStep[] };

export type UploadTicket = { item_id: string; url: string; expires_in: number };
