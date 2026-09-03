import { api, API_BASE } from "./client";
import { ApiError } from "./errors";
import type { Item, UploadTicket } from "./types";

export type UploadPhase = "reserving" | "uploading" | "finishing" | "done" | "failed";

/**
 * `fetch` cannot report upload progress, so the direct-to-S3 PUT uses
 * XMLHttpRequest. This is the only place in the app that does.
 */
export function putWithProgress(
  url: string,
  file: File,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    // onload fires for a 403 just as it does for a 200 — only onerror is
    // reserved for transport faults, so the status must be checked explicitly.
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new ApiError(xhr.status, `upload failed (${xhr.status})`));
    xhr.onerror = () => reject(new ApiError(0, "network error during upload"));
    xhr.onabort = () => reject(new ApiError(0, "upload cancelled"));

    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

/**
 * The three-step handshake: reserve, PUT the bytes straight to S3, confirm.
 *
 * Note what the completion call does NOT send: size and mime. The server reads
 * both from the storage backend's head(), because a client-supplied size is a
 * quota-bypass and metadata-forgery primitive. Do not add them here.
 */
export async function uploadFile(opts: {
  spaceId: string;
  parentId: string | null;
  file: File;
  onPhase: (p: UploadPhase) => void;
  onProgress: (fraction: number) => void;
  signal?: AbortSignal;
}): Promise<Item> {
  const { spaceId, parentId, file, onPhase, onProgress, signal } = opts;

  onPhase("reserving");
  const ticket = await api.post<UploadTicket>(`/api/spaces/${spaceId}/uploads`, {
    name: file.name,
    parent_id: parentId,
    mime: file.type || "application/octet-stream",
  });

  onPhase("uploading");
  try {
    await putWithProgress(ticket.url, file, onProgress, signal);
  } catch (e) {
    // A failed PUT must reject without calling complete — calling it would
    // ask the server to confirm bytes that never arrived (a correct 400),
    // but the user would see a confusing error instead of a clean retry.
    onPhase("failed");
    throw e;
  }
  onProgress(1);

  onPhase("finishing");
  try {
    const item = await api.post<Item>(`/api/items/${ticket.item_id}/complete`);
    onPhase("done");
    return item;
  } catch (e) {
    onPhase("failed");
    throw e;
  }
}

export { API_BASE };
