# Hdrive Frontend Implementation Plan — Part 2 (Tasks 7–12)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Continues:** `docs/superpowers/plans/2026-09-03-hdrive-frontend.md` (Tasks 1–6).
**Spec:** `docs/superpowers/specs/2026-09-03-hdrive-frontend-design.md`
**Design reference:** `docs/references/design-extraction.md`

Part 1's **Global Constraints** and **Verified Environment Facts** apply to every
task here. Re-read them — especially that `PATCH /api/items/:id` does both rename
and move, that no-access is 404 (never 403), and that share unlock is two steps.

---

### Task 7: Upload — the three-step handshake

The mockup's upload toast shows progress only. It needs a **finishing** state
(bytes landed, confirm in flight) and a **failed** state with retry, because the
direct PUT can fail independently of the reserve.

**Files:**
- Create: `apps/web/src/api/upload.ts`
- Create: `apps/web/src/components/UploadToast.tsx`, `Dropzone.tsx`
- Modify: `apps/web/src/api/queries.ts`, `apps/web/src/routes/Files.tsx`
- Test: `apps/web/test/upload.test.ts`, `apps/web/test/uploadToast.test.tsx`

**Interfaces:**
- Consumes: `api`, `ApiError`, `UploadTicket`, `Item`.
- Produces:
  - `type UploadPhase = "reserving" | "uploading" | "finishing" | "done" | "failed"`
  - `type UploadState = { id: string; name: string; phase: UploadPhase; progress: number; itemId?: string; error?: string }`
  - `uploadFile(opts): Promise<Item>` where
    `opts = { spaceId: string; parentId: string | null; file: File; onPhase(p: UploadPhase): void; onProgress(fraction: number): void; signal?: AbortSignal }`
  - `putWithProgress(url, file, onProgress, signal): Promise<void>`
  - `useUploads()` → `{ uploads: UploadState[]; start(files: FileList | File[]): void; retry(id: string): void; dismiss(id: string): void }`

- [ ] **Step 1: Write the failing test** — `apps/web/test/upload.test.ts`

```ts
import { afterEach, expect, test, vi } from "vitest";
import { uploadFile } from "../src/api/upload";
import { ApiError } from "../src/api/errors";

const file = () => new File(["hello hdrive"], "notes.txt", { type: "text/plain" });

/** Minimal XMLHttpRequest double: records the PUT and drives progress/exit. */
function stubXhr(opts: { status?: number; fail?: boolean } = {}) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  class FakeXhr {
    upload = { onprogress: null as null | ((e: ProgressEvent) => void) };
    onload: null | (() => void) = null;
    onerror: null | (() => void) = null;
    onabort: null | (() => void) = null;
    status = opts.status ?? 200;
    open(method: string, url: string) { calls.push({ method, url, body: null }); }
    setRequestHeader() {}
    send(body: unknown) {
      calls[calls.length - 1].body = body;
      queueMicrotask(() => {
        this.upload.onprogress?.({ lengthComputable: true, loaded: 6, total: 12 } as ProgressEvent);
        this.upload.onprogress?.({ lengthComputable: true, loaded: 12, total: 12 } as ProgressEvent);
        if (opts.fail) this.onerror?.(); else this.onload?.();
      });
    }
    abort() { this.onabort?.(); }
  }
  vi.stubGlobal("XMLHttpRequest", FakeXhr as unknown as typeof XMLHttpRequest);
  return calls;
}

const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

test("the happy path walks reserve -> upload -> finish and returns the ready item", async () => {
  const puts = stubXhr();
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonRes(201, { item_id: "i1", url: "https://s3.test/put", expires_in: 900 }))
    .mockResolvedValueOnce(jsonRes(200, { id: "i1", status: "ready", size: 12, name: "notes.txt" }));
  vi.stubGlobal("fetch", fetchMock);

  const phases: string[] = [];
  const fractions: number[] = [];
  const item = await uploadFile({
    spaceId: "s1", parentId: null, file: file(),
    onPhase: (p) => phases.push(p), onProgress: (f) => fractions.push(f),
  });

  expect(phases).toEqual(["reserving", "uploading", "finishing", "done"]);
  expect(fractions.at(-1)).toBe(1);
  expect(item.status).toBe("ready");
  expect(item.size).toBe(12);

  expect(puts[0].method).toBe("PUT");
  expect(puts[0].url).toBe("https://s3.test/put");
  expect(fetchMock.mock.calls[0][0]).toContain("/api/spaces/s1/uploads");
  expect(fetchMock.mock.calls[1][0]).toContain("/api/items/i1/complete");
});

test("the completion call sends NO size or mime — the server reads them from storage", async () => {
  stubXhr();
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonRes(201, { item_id: "i1", url: "https://s3.test/put", expires_in: 900 }))
    .mockResolvedValueOnce(jsonRes(200, { id: "i1", status: "ready", size: 12 }));
  vi.stubGlobal("fetch", fetchMock);

  await uploadFile({ spaceId: "s1", parentId: null, file: file(), onPhase: () => {}, onProgress: () => {} });

  const completeBody = fetchMock.mock.calls[1][1]?.body;
  const parsed = completeBody ? JSON.parse(completeBody as string) : {};
  expect(parsed.size).toBeUndefined();
  expect(parsed.mime).toBeUndefined();
});

test("a failed PUT rejects without ever calling complete", async () => {
  stubXhr({ fail: true });
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonRes(201, { item_id: "i1", url: "https://s3.test/put", expires_in: 900 }));
  vi.stubGlobal("fetch", fetchMock);

  const phases: string[] = [];
  await expect(uploadFile({
    spaceId: "s1", parentId: null, file: file(),
    onPhase: (p) => phases.push(p), onProgress: () => {},
  })).rejects.toBeInstanceOf(ApiError);

  expect(phases).toEqual(["reserving", "uploading", "failed"]);
  expect(fetchMock).toHaveBeenCalledTimes(1); // reserve only
});

test("a non-2xx PUT status is a failure, not a success", async () => {
  stubXhr({ status: 403 });
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(jsonRes(201, { item_id: "i1", url: "https://s3.test/put", expires_in: 900 })));
  await expect(uploadFile({
    spaceId: "s1", parentId: null, file: file(), onPhase: () => {}, onProgress: () => {},
  })).rejects.toMatchObject({ status: 403 });
});

test("a 503 from reserve (no storage backend configured) surfaces unchanged", async () => {
  stubXhr();
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(jsonRes(503, { error: "no storage backend is configured for uploads" })));
  await expect(uploadFile({
    spaceId: "s1", parentId: null, file: file(), onPhase: () => {}, onProgress: () => {},
  })).rejects.toMatchObject({ status: 503 });
});

test("progress reaches 1 before the finishing phase begins", async () => {
  stubXhr();
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(jsonRes(201, { item_id: "i1", url: "https://s3.test/put", expires_in: 900 }))
    .mockResolvedValueOnce(jsonRes(200, { id: "i1", status: "ready" })));

  const events: string[] = [];
  await uploadFile({
    spaceId: "s1", parentId: null, file: file(),
    onPhase: (p) => events.push(`phase:${p}`),
    onProgress: (f) => events.push(`progress:${f}`),
  });
  expect(events.indexOf("progress:1")).toBeLessThan(events.indexOf("phase:finishing"));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npm test`
Expected: FAIL — cannot resolve `../src/api/upload`.

- [ ] **Step 3: Write `apps/web/src/api/upload.ts`**

```ts
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
 * The three-step handshake.
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && npm test -- upload`
Expected: 6 pass.

- [ ] **Step 5: Add `useUploads` to `apps/web/src/api/queries.ts`**

```ts
import { useCallback, useRef, useState } from "react";
import { uploadFile, type UploadPhase } from "./upload";

export type UploadState = {
  id: string; name: string; phase: UploadPhase; progress: number;
  itemId?: string; error?: string;
};

export function useUploads(spaceId: string, parentId: string | null) {
  const qc = useQueryClient();
  const [uploads, setUploads] = useState<UploadState[]>([]);
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
```

- [ ] **Step 6: Write the failing toast test** — `apps/web/test/uploadToast.test.tsx`

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import UploadToast from "../src/components/UploadToast";
import type { UploadState } from "../src/api/queries";

const u = (over: Partial<UploadState> = {}): UploadState =>
  ({ id: "1", name: "notes.txt", phase: "uploading", progress: 0.5, ...over });

test("shows a percentage while uploading", () => {
  render(<UploadToast uploads={[u()]} onRetry={() => {}} onDismiss={() => {}} />);
  expect(screen.getByText(/50%/)).toBeInTheDocument();
});

test("the finishing phase is distinct from a stalled 100% bar", () => {
  render(<UploadToast uploads={[u({ phase: "finishing", progress: 1 })]} onRetry={() => {}} onDismiss={() => {}} />);
  expect(screen.getByText(/finishing/i)).toBeInTheDocument();
  expect(screen.queryByText(/100%/)).toBeNull();
});

test("a failure shows the reason and offers retry", async () => {
  const onRetry = vi.fn();
  render(<UploadToast uploads={[u({ phase: "failed", error: "network error during upload" })]}
                      onRetry={onRetry} onDismiss={() => {}} />);
  expect(screen.getByText(/network error during upload/i)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /retry/i }));
  expect(onRetry).toHaveBeenCalledWith("1");
});

test("nothing renders when there are no uploads", () => {
  const { container } = render(<UploadToast uploads={[]} onRetry={() => {}} onDismiss={() => {}} />);
  expect(container).toBeEmptyDOMElement();
});

test("a completed upload can be dismissed", async () => {
  const onDismiss = vi.fn();
  render(<UploadToast uploads={[u({ phase: "done", progress: 1 })]} onRetry={() => {}} onDismiss={onDismiss} />);
  await userEvent.click(screen.getByRole("button", { name: /dismiss|close/i }));
  expect(onDismiss).toHaveBeenCalledWith("1");
});
```

- [ ] **Step 7: Write `apps/web/src/components/UploadToast.tsx` and `Dropzone.tsx`**

```tsx
// UploadToast.tsx
import type { UploadState } from "../api/queries";

const LABEL: Record<UploadState["phase"], string> = {
  reserving: "Preparing…",
  uploading: "",           // replaced by the percentage
  finishing: "Finishing…", // bytes are up; the server is confirming
  done: "Uploaded",
  failed: "Failed",
};

export default function UploadToast(
  { uploads, onRetry, onDismiss }:
  { uploads: UploadState[]; onRetry: (id: string) => void; onDismiss: (id: string) => void },
) {
  if (uploads.length === 0) return null;
  return (
    <div className="toast rise" role="status" aria-live="polite">
      {uploads.map((up) => (
        <div key={up.id} className="toast-row">
          <span className="toast-name">{up.name}</span>
          <span className="toast-status">
            {up.phase === "uploading" ? `${Math.round(up.progress * 100)}%` : LABEL[up.phase]}
          </span>
          {up.phase !== "failed" && (
            <div className="toast-bar"><div style={{ width: `${up.progress * 100}%` }} /></div>
          )}
          {up.phase === "failed" && (
            <>
              <span className="toast-error">{up.error}</span>
              <button onClick={() => onRetry(up.id)}>Retry</button>
            </>
          )}
          {(up.phase === "done" || up.phase === "failed") && (
            <button aria-label="Dismiss" onClick={() => onDismiss(up.id)}>×</button>
          )}
        </div>
      ))}
    </div>
  );
}
```

```tsx
// Dropzone.tsx — the mockup's dashed empty-state affordance (#C9CDD4, 1px dashed).
import { useRef, useState } from "react";

export default function Dropzone({ onFiles }: { onFiles: (f: FileList | File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      className={`dropzone${over ? " is-over" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); onFiles(e.dataTransfer.files); }}
    >
      <button onClick={() => input.current?.click()}>Upload files</button>
      <input ref={input} type="file" multiple hidden
             onChange={(e) => { if (e.target.files) onFiles(e.target.files); e.target.value = ""; }} />
      <p>or drop them here</p>
    </div>
  );
}
```

Style `.toast` with `box-shadow: var(--shadow-toast); border-radius: var(--r-card);
background: var(--surface); position: fixed; right: 24px; bottom: 24px;`, and
`.toast-bar > div` with `transition: width 0.4s linear` per the mockup's motion notes.

- [ ] **Step 8: Wire uploads into `Files.tsx`**

```tsx
const { uploads, start, retry, dismiss } = useUploads(spaceId, itemId);
// …render <Dropzone onFiles={start} /> above the table,
// and <UploadToast uploads={uploads} onRetry={retry} onDismiss={dismiss} /> at the end.
```

- [ ] **Step 9: Run everything, then break a predicate**

```bash
cd apps/web && npm test && npm run typecheck
```
Expected: 42 pass.

Then: add `size: file.size` to the complete call's body and confirm the
"sends NO size or mime" test fails. Remove the `onPhase("finishing")` call and
confirm the finishing test fails. Restore both; report which caught which.

- [ ] **Step 10: Commit**

```bash
git add apps/web && git commit -m "feat(web): three-step upload with progress, finishing, and retry"
```

---

### Task 8: Download and video with seeking

**Files:**
- Create: `apps/web/src/routes/Item.tsx`, `apps/web/src/components/VideoPlayer.tsx`
- Modify: `apps/web/src/api/queries.ts`, `App.tsx`
- Test: `apps/web/test/item.test.tsx`

**Interfaces:**
- Produces: `useItem(itemId)`, `contentUrl(itemId, {inline})`, `<VideoPlayer>`, `<Item>`.

**Key fact:** seeking needs no player library. `<video src="…/content?inline=1">`
issues Range requests, and the API already returns 206 with `content-range`.
The `<video>` element must be given `credentials`-bearing requests, which it does
by default for same-site cookies only when `crossOrigin="use-credentials"` is set
and the API allows that origin — Task 1's CORS does.

- [ ] **Step 1: Add `useItem` and `contentUrl` to `queries.ts`**

```ts
import { API_BASE } from "./client";

export function useItem(itemId: string) {
  return useQuery<Item>({
    queryKey: ["item", itemId],
    queryFn: () => api.get<Item>(`/api/items/${itemId}`),
    enabled: Boolean(itemId),
  });
}

export const contentUrl = (itemId: string, opts: { inline?: boolean } = {}) =>
  `${API_BASE}/api/items/${itemId}/content${opts.inline ? "?inline=1" : ""}`;
```

- [ ] **Step 2: Write the failing test** — `apps/web/test/item.test.tsx`

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, test } from "vitest";
import VideoPlayer from "../src/components/VideoPlayer";
import { contentUrl } from "../src/api/queries";

const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient()}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);

test("contentUrl targets the API and can request inline disposition", () => {
  expect(contentUrl("i1")).toMatch(/\/api\/items\/i1\/content$/);
  expect(contentUrl("i1", { inline: true })).toMatch(/\?inline=1$/);
});

test("the video element streams inline and sends credentials", () => {
  wrap(<VideoPlayer itemId="i1" name="clip.mp4" />);
  const v = screen.getByTestId("video") as HTMLVideoElement;
  expect(v.getAttribute("src")).toContain("inline=1");
  expect(v.getAttribute("crossorigin")).toBe("use-credentials");
  expect(v).toHaveAttribute("controls");
  // preload=metadata lets the browser fetch the duration (and thus enable the
  // scrub bar) with a Range request instead of pulling the whole file.
  expect(v.getAttribute("preload")).toBe("metadata");
});

test("the download link uses attachment disposition, not inline", () => {
  wrap(<VideoPlayer itemId="i1" name="clip.mp4" />);
  const a = screen.getByRole("link", { name: /download/i });
  expect(a.getAttribute("href")).not.toContain("inline=1");
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd apps/web && npm test -- item`
Expected: FAIL — cannot resolve `../src/components/VideoPlayer`.

- [ ] **Step 4: Write `apps/web/src/components/VideoPlayer.tsx`**

```tsx
import { contentUrl } from "../api/queries";

/**
 * No player library: the API serves Range requests and returns 206, so a plain
 * <video> gets seeking for free. crossOrigin="use-credentials" is required
 * because the API is a different origin and the session is a cookie.
 */
export default function VideoPlayer({ itemId, name }: { itemId: string; name: string }) {
  return (
    <div className="player">
      <video
        data-testid="video"
        src={contentUrl(itemId, { inline: true })}
        crossOrigin="use-credentials"
        controls
        preload="metadata"
        className="player-video"
      />
      <div className="player-bar">
        <span className="player-name">{name}</span>
        <a className="btn" href={contentUrl(itemId)} download={name}>Download</a>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Write `apps/web/src/routes/Item.tsx`**

```tsx
import { useParams } from "react-router-dom";
import { useItem } from "../api/queries";
import { isNotFound } from "../api/errors";
import { formatBytes } from "../lib/format";
import EmptyState from "../components/EmptyState";
import VideoPlayer from "../components/VideoPlayer";
import { contentUrl } from "../api/queries";

export default function Item() {
  const { itemId = "" } = useParams();
  const { data: item, isPending, error } = useItem(itemId);

  if (isPending) return null;
  if (error && isNotFound(error)) {
    return <EmptyState title="Not found" hint="This file does not exist, or you do not have access." />;
  }
  if (error || !item) return <EmptyState title="Something went wrong" />;
  if (item.status !== "ready") {
    return <EmptyState title="Still uploading" hint="This file has not finished uploading yet." />;
  }

  const isVideo = (item.mime ?? "").startsWith("video/");
  return (
    <div className="item-detail">
      <h1>{item.name}</h1>
      <p className="mono-label">{formatBytes(item.size)} · {item.mime ?? "unknown type"}</p>
      {isVideo
        ? <VideoPlayer itemId={item.id} name={item.name} />
        : <a className="btn" href={contentUrl(item.id)} download={item.name}>Download</a>}
    </div>
  );
}
```

Add `<Route path="/i/:itemId" element={<Item />} />` inside the `AppShell` block.

- [ ] **Step 6: Run everything and commit**

```bash
cd apps/web && npm test && npm run typecheck
git add apps/web && git commit -m "feat(web): file detail and range-seeking video playback"
```

Expected: 46 pass.

---

### Task 9: Item actions — rename, move, trash, restore

**Files:**
- Create: `apps/web/src/components/RenameCell.tsx`, `MoveModal.tsx`, `Modal.tsx`, `RowMenu.tsx`
- Create: `apps/web/src/routes/Trash.tsx`
- Modify: `queries.ts`, `FileTable.tsx`, `App.tsx`
- Test: `apps/web/test/actions.test.tsx`

**Interfaces:**
- Produces: `useRenameItem()`, `useMoveItem()`, `useDeleteItem()`, `useRestoreItem()`, `useTrash(spaceId)`, `<Modal>`, `<RenameCell>`, `<MoveModal>`, `<RowMenu>`, `<Trash>`.

**Key fact:** `PATCH /api/items/:id` handles both `{name}` and `{parent_id}` in one
transactional call. A name collision returns **409**; the UI must show it inline
rather than as a generic failure. Restoring into a reused name also returns 409.

- [ ] **Step 1: Add the mutations to `queries.ts`**

```ts
export function useRenameItem(spaceId: string, parentId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; name: string }) =>
      api.patch<Item>(`/api/items/${v.id}`, { name: v.name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["children", spaceId, parentId] }),
  });
}

export function useMoveItem(spaceId: string, parentId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; parent_id: string | null }) =>
      api.patch<Item>(`/api/items/${v.id}`, { parent_id: v.parent_id }),
    // A move changes two folders, so invalidate every listing in the space.
    onSuccess: () => qc.invalidateQueries({ queryKey: ["children", spaceId] }),
  });
}

export function useDeleteItem(spaceId: string, parentId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<null>(`/api/items/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["children", spaceId, parentId] });
      qc.invalidateQueries({ queryKey: ["trash", spaceId] });
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
```

- [ ] **Step 2: Write the failing test** — `apps/web/test/actions.test.tsx`

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import RenameCell from "../src/components/RenameCell";
import MoveModal from "../src/components/MoveModal";
import type { Item } from "../src/api/types";

const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>{ui}</QueryClientProvider>);

const folder = (id: string, name: string, path: string[]): Item => ({
  id, space_id: "s1", parent_id: null, kind: "folder", name, path_ids: path,
  size: null, mime: null, storage_backend_id: null, storage_key: null,
  status: "ready", deleted_at: null, created_by: "u1", created_at: "2026-09-01T00:00:00Z",
});

afterEach(() => vi.unstubAllGlobals());

test("Enter commits a rename, Escape cancels it", async () => {
  const onCommit = vi.fn();
  wrap(<RenameCell name="notes.txt" onCommit={onCommit} onCancel={() => {}} error={null} />);
  const input = screen.getByRole("textbox");
  await userEvent.clear(input);
  await userEvent.type(input, "renamed.txt{Enter}");
  expect(onCommit).toHaveBeenCalledWith("renamed.txt");

  onCommit.mockClear();
  await userEvent.type(input, "{Escape}");
  expect(onCommit).not.toHaveBeenCalled();
});

test("a 409 name conflict is shown inline, not as a generic failure", () => {
  wrap(<RenameCell name="notes.txt" onCommit={() => {}} onCancel={() => {}}
                   error="an item with that name already exists here" />);
  expect(screen.getByRole("alert")).toHaveTextContent(/already exists/i);
});

test("the move picker disables the item's own subtree as a destination", () => {
  const a = folder("a", "A", ["a"]);
  const b = folder("b", "B", ["a", "b"]);   // descendant of A
  const c = folder("c", "C", ["c"]);        // unrelated
  wrap(<MoveModal item={a} folders={[a, b, c]} onMove={() => {}} onClose={() => {}} pending={false} />);

  expect(screen.getByRole("button", { name: /^C$/ })).toBeEnabled();
  expect(screen.getByRole("button", { name: /^A$/ })).toBeDisabled();  // itself
  expect(screen.getByRole("button", { name: /^B$/ })).toBeDisabled();  // its descendant
});

test("the move picker offers the space root", () => {
  const a = folder("a", "A", ["a"]);
  const onMove = vi.fn();
  wrap(<MoveModal item={a} folders={[a]} onMove={onMove} onClose={() => {}} pending={false} />);
  userEvent.click(screen.getByRole("button", { name: /space root/i }));
  waitFor(() => expect(onMove).toHaveBeenCalledWith(null));
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd apps/web && npm test -- actions`
Expected: FAIL — cannot resolve `../src/components/RenameCell`.

- [ ] **Step 4: Write `Modal.tsx`, `RenameCell.tsx`, `MoveModal.tsx`**

```tsx
// Modal.tsx
import { type ReactNode, useEffect } from "react";

export default function Modal(
  { title, children, onClose }: { title: string; children: ReactNode; onClose: () => void },
) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal rise" role="dialog" aria-modal="true" aria-label={title}
           onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}
```

```tsx
// RenameCell.tsx — inline edit, per the spec (not a modal).
import { useState } from "react";

export default function RenameCell(
  { name, onCommit, onCancel, error }:
  { name: string; onCommit: (next: string) => void; onCancel: () => void; error: string | null },
) {
  const [value, setValue] = useState(name);
  return (
    <div className="rename-cell">
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); onCommit(value.trim()); }
          if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        }}
        aria-label="New name"
      />
      {error && <p role="alert" className="field-error">{error}</p>}
    </div>
  );
}
```

```tsx
// MoveModal.tsx
import type { Item } from "../api/types";
import Modal from "./Modal";

export default function MoveModal(
  { item, folders, onMove, onClose, pending }:
  { item: Item; folders: Item[]; onMove: (parentId: string | null) => void;
    onClose: () => void; pending: boolean },
) {
  // A folder cannot move into itself or its own descendant. `path_ids` contains
  // every ancestor plus self, so a candidate whose path includes this item's id
  // is inside its subtree.
  const disabled = (f: Item) => f.id === item.id || f.path_ids.includes(item.id);

  return (
    <Modal title={`Move “${item.name}”`} onClose={onClose}>
      <ul className="move-list">
        <li>
          <button onClick={() => onMove(null)} disabled={pending}>Space root</button>
        </li>
        {folders.filter((f) => f.kind === "folder").map((f) => (
          <li key={f.id}>
            <button onClick={() => onMove(f.id)} disabled={pending || disabled(f)}>{f.name}</button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
```

- [ ] **Step 5: Write `apps/web/src/routes/Trash.tsx`**

```tsx
import { useParams } from "react-router-dom";
import { useRestoreItem, useTrash } from "../api/queries";
import { isConflict } from "../api/errors";
import EmptyState from "../components/EmptyState";
import { formatDate } from "../lib/format";

export default function Trash() {
  const { spaceId = "" } = useParams();
  const { data: items, isPending } = useTrash(spaceId);
  const restore = useRestoreItem(spaceId);

  if (isPending) return null;
  if (!items?.length) {
    return <EmptyState title="Trash is empty" hint="Deleted items appear here for 30 days." />;
  }

  return (
    <>
      {restore.error && (
        <p role="alert" className="field-error">
          {isConflict(restore.error)
            ? "Something with that name already exists here. Rename it first, then restore."
            : (restore.error as Error).message}
        </p>
      )}
      <table className="file-table">
        <thead>
          <tr>{["NAME", "DELETED", ""].map((h) => <th key={h} className="mono-label">{h}</th>)}</tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr key={it.id}>
              <td>{it.name}</td>
              <td>{it.deleted_at ? formatDate(it.deleted_at) : "—"}</td>
              <td>
                <button onClick={() => restore.mutate(it.id)} disabled={restore.isPending}>
                  Restore
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
```

Add `<Route path="/s/:spaceId/trash" element={<Trash />} />` inside `AppShell`.

- [ ] **Step 6: Wire `RowMenu` into `FileTable`** with Rename / Move / Delete,
      surfacing a 409 from rename inline via `RenameCell`'s `error` prop.

- [ ] **Step 7: Run, break a predicate, commit**

```bash
cd apps/web && npm test && npm run typecheck
```
Expected: 51 pass.

Break: remove `f.path_ids.includes(item.id)` from `disabled()` and confirm the
subtree test fails. Restore.

```bash
git add apps/web && git commit -m "feat(web): rename, move, trash, and restore"
```

---

### Task 10: Sharing — modal, links list, and the public unlock page

**Files:**
- Create: `apps/web/src/components/ShareModal.tsx`
- Create: `apps/web/src/routes/share/Unlock.tsx`, `apps/web/src/routes/share/View.tsx`
- Modify: `queries.ts`, `App.tsx`, `FileTable.tsx`
- Test: `apps/web/test/share.test.tsx`

**Interfaces:**
- Produces: `useShares(itemId)`, `useCreateShare(itemId)`, `useRevokeShare(itemId)`, `<ShareModal>`, `<Unlock>`, `<ShareView>`.

**Critical:** the raw token is returned **once**, at creation. If the user closes
the modal without copying it, it is gone — the UI must say so. Never imply a
token can be retrieved later.

**Also critical:** unknown / expired / revoked all return an identical 404; only
a wrong password is 401. **The unlock page must not add distinctions the API
deliberately removed** — do not say "this link expired" when the API said 404.

- [ ] **Step 1: Add share hooks to `queries.ts`**

```ts
import type { CreatedShareLink, ShareLink } from "./types";

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
    onSuccess: () => qc.invalidateQueries({ queryKey: ["shares", itemId] }),
  });
}

export function useRevokeShare(itemId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (linkId: string) => api.del<null>(`/api/shares/${linkId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["shares", itemId] }),
  });
}
```

- [ ] **Step 2: Write the failing test** — `apps/web/test/share.test.tsx`

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import Unlock from "../src/routes/share/Unlock";

const wrap = (ui: React.ReactNode, initial = "/share/tok123") =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes><Route path="/share/:token" element={ui} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

const res = (status: number, body: unknown) =>
  new Response(body === null ? null : JSON.stringify(body),
    { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

test("a wrong password says so and lets the viewer retry", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res(401, { error: "password required" })));
  wrap(<Unlock />);
  await userEvent.type(screen.getByLabelText(/password/i), "nope");
  await userEvent.click(screen.getByRole("button", { name: /unlock|view/i }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/password/i);
  expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
});

test("a 404 gives ONE uniform message and no hint about which reason", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res(404, { error: "link not found or expired" })));
  wrap(<Unlock />);
  await userEvent.type(screen.getByLabelText(/password/i), "whatever");
  await userEvent.click(screen.getByRole("button", { name: /unlock|view/i }));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(/not found or expired/i);
  // The API refuses to distinguish these; the UI must not invent a distinction.
  expect(alert.textContent).not.toMatch(/revoked/i);
  expect(alert.textContent).not.toMatch(/deleted/i);
  expect(alert.textContent).not.toMatch(/this link expired/i);
});

test("the unlock page has no app chrome — the viewer is not signed in", () => {
  vi.stubGlobal("fetch", vi.fn());
  wrap(<Unlock />);
  expect(screen.queryByText(/my files/i)).toBeNull();
  expect(screen.queryByText(/log out/i)).toBeNull();
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd apps/web && npm test -- share`
Expected: FAIL — cannot resolve `../src/routes/share/Unlock`.

- [ ] **Step 4: Write `apps/web/src/routes/share/Unlock.tsx` and `View.tsx`**

```tsx
// Unlock.tsx
import { type FormEvent, useState } from "react";
import { useParams } from "react-router-dom";
import { API_BASE } from "../../api/client";
import { ApiError } from "../../api/errors";
import ShareView from "./View";

export default function Unlock() {
  const { token = "" } = useParams();
  const [password, setPassword] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await fetch(`${API_BASE}/s/${token}/unlock`, {
        method: "POST",
        credentials: "include", // the unlock cookie must be stored
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        // Show exactly what the API said. It returns one uniform 404 for
        // unknown/expired/revoked on purpose; inventing a more specific
        // message here would leak what the API refuses to disclose.
        throw new ApiError(r.status, body.error ?? "could not open this link");
      }
      setUnlocked(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not open this link");
    } finally {
      setBusy(false);
    }
  };

  if (unlocked) return <ShareView token={token} />;

  return (
    <main className="share-page">
      <form className="share-card rise" onSubmit={submit}>
        <h1>This link is password protected</h1>
        <label htmlFor="pw">Password</label>
        <input id="pw" type="password" autoComplete="off" value={password}
               onChange={(e) => setPassword(e.target.value)} />
        {error && <p role="alert" className="field-error">{error}</p>}
        <button type="submit" disabled={busy}>{busy ? "Opening…" : "Unlock"}</button>
      </form>
    </main>
  );
}
```

```tsx
// View.tsx — streams through the public route; the cookie (if any) is already set.
import { API_BASE } from "../../api/client";

export default function ShareView({ token }: { token: string }) {
  const src = `${API_BASE}/s/${token}`;
  return (
    <main className="share-page">
      <div className="share-viewer">
        <video data-testid="share-video" src={src} crossOrigin="use-credentials"
               controls preload="metadata" />
        <a className="btn" href={src}>Download</a>
      </div>
    </main>
  );
}
```

Add outside `RequireAuth` in `App.tsx`:

```tsx
<Route path="/share/:token" element={<Unlock />} />
```

- [ ] **Step 5: Write `ShareModal.tsx`**

Key behaviours: expiry select (7 days default, plus 1/30/never), optional
password, mode (view/download), a created-link panel showing the token URL with a
**copy** button and the warning that it is shown once, and a list of existing
links with **Revoke**. Never render a token for an existing link — the API cannot
return it.

```tsx
// The one-time token warning is not decoration: the API stores only a SHA-256,
// so a link the user fails to copy is unrecoverable and must be re-created.
{created && (
  <div className="share-created">
    <p className="mono-label">Copy this link now — it is shown only once.</p>
    <input readOnly value={`${location.origin}/share/${created.token}`} />
    <button onClick={() => navigator.clipboard.writeText(`${location.origin}/share/${created.token}`)}>
      Copy
    </button>
  </div>
)}
```

- [ ] **Step 6: Run everything, break a predicate, commit**

```bash
cd apps/web && npm test && npm run typecheck
```
Expected: 54 pass.

Break: change the 404 branch to render "This link has expired" and confirm the
uniform-message test fails. Restore.

```bash
git add apps/web && git commit -m "feat(web): share modal and public unlock/view pages"
```

---

### Task 11: Permissions and admin

**Files:**
- Create: `apps/web/src/components/PermissionsModal.tsx`
- Create: `apps/web/src/routes/admin/Backends.tsx`, `Users.tsx`, `Groups.tsx`
- Modify: `queries.ts`, `App.tsx`
- Test: `apps/web/test/permissions.test.tsx`, `apps/web/test/admin.test.tsx`

**Interfaces:**
- Produces: `useGrants(itemId)`, `useGrantItem(itemId)`, `useRevokeGrant(itemId)`, `useSpaceMembers(spaceId)`, `useGroups()`, `useAdminUsers()`, `useSetAdmin()`, `useBackends()`, `useCreateBackend()`, `useSetWriteTarget()`, `useProbeBackend()`, `useDeleteBackend()`, and the three admin routes.

**These depend on Task 1's endpoints** (`GET /api/groups`, `GET /api/spaces/:id/members`).

- [ ] **Step 1: Add the hooks to `queries.ts`**

```ts
import type { Backend, Grant, Group, ProbeResult, SpaceMember, Subject, User } from "./types";

export const useGrants = (itemId: string) =>
  useQuery<Grant[]>({ queryKey: ["grants", itemId],
    queryFn: () => api.get<Grant[]>(`/api/items/${itemId}/grants`), enabled: Boolean(itemId) });

export function useGrantItem(itemId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { subject: Subject; role: "viewer" | "editor" | "owner" }) =>
      api.post<null>(`/api/items/${itemId}/grants`, v),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["grants", itemId] }),
  });
}

export function useRevokeGrant(itemId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (subject: Subject) => api.del<null>(`/api/items/${itemId}/grants`, { subject }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["grants", itemId] }),
  });
}

export const useSpaceMembers = (spaceId: string) =>
  useQuery<SpaceMember[]>({ queryKey: ["spaceMembers", spaceId],
    queryFn: () => api.get<SpaceMember[]>(`/api/spaces/${spaceId}/members`), enabled: Boolean(spaceId) });

export const useGroups = () =>
  useQuery<Group[]>({ queryKey: ["groups"], queryFn: () => api.get<Group[]>("/api/groups") });

export const useAdminUsers = () =>
  useQuery<User[]>({ queryKey: ["adminUsers"], queryFn: () => api.get<User[]>("/api/admin/users") });

export function useSetAdmin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; is_admin: boolean }) =>
      api.patch<User>(`/api/admin/users/${v.id}`, { is_admin: v.is_admin }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["adminUsers"] }),
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
```

- [ ] **Step 2: Write the failing admin test** — `apps/web/test/admin.test.tsx`

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import BackendRow from "../src/routes/admin/BackendRow";
import type { Backend, ProbeResult } from "../src/api/types";

const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>{ui}</QueryClientProvider>);

const backend = (over: Partial<Backend> = {}): Backend => ({
  id: "b1", name: "primary", provider: "s3", is_write_target: true,
  created_at: "2026-09-01T00:00:00Z", item_count: 3, ...over,
});

afterEach(() => vi.unstubAllGlobals());

test("the write target is marked, and a non-target offers to become one", () => {
  const { unmount } = wrap(<BackendRow backend={backend()} />);
  expect(screen.getByText(/write target/i)).toBeInTheDocument();
  unmount();
  wrap(<BackendRow backend={backend({ is_write_target: false })} />);
  expect(screen.getByRole("button", { name: /make write target/i })).toBeInTheDocument();
});

test("a backend still holding files cannot be deleted", () => {
  wrap(<BackendRow backend={backend({ is_write_target: false, item_count: 3 })} />);
  expect(screen.getByRole("button", { name: /delete/i })).toBeDisabled();
});

test("an empty backend can be deleted", () => {
  wrap(<BackendRow backend={backend({ is_write_target: false, item_count: 0 })} />);
  expect(screen.getByRole("button", { name: /delete/i })).toBeEnabled();
});

test("the probe shows every step, including which one failed", async () => {
  const result: ProbeResult = {
    ok: false,
    steps: [
      { step: "presign+put", ok: true },
      { step: "head", ok: false, detail: "object not found after a successful PUT" },
    ],
  };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } }),
  ));
  wrap(<BackendRow backend={backend()} />);
  await userEvent.click(screen.getByRole("button", { name: /test connection/i }));
  expect(await screen.findByText("presign\\+put")).toBeInTheDocument();
  expect(screen.getByText(/object not found after a successful PUT/i)).toBeInTheDocument();
});
```

- [ ] **Step 3: Run to verify it fails, then implement**

Run: `cd apps/web && npm test -- admin` → FAIL.

Write `apps/web/src/routes/admin/BackendRow.tsx` rendering the name, provider,
item count, a "Write target" pill when `is_write_target`, a **Make write target**
button otherwise, **Test connection** (calls `useProbeBackend`, renders each step
with a tick/cross and the `detail` when a step fails), and **Delete** disabled
whenever `item_count > 0` with the title "This backend still holds files".

Then `Backends.tsx` (list + add form: name, endpoint, bucket, accessKeyId,
secretAccessKey, `virtualHostedStyle` checkbox, "make write target" checkbox),
`Users.tsx` (list, promote/demote via `useSetAdmin`, surfacing the 409 when
demoting the last admin), and `Groups.tsx` (list with member counts, create).

Add the routes inside `AppShell`, each guarding on `me.is_admin`.

- [ ] **Step 4: Write `PermissionsModal.tsx`** — two tabs, **People** and
      **Groups**, both listing current grants with a role select and Remove, and
      an add row. The Groups tab is populated from `useGroups()`.

- [ ] **Step 5: Run, break a predicate, commit**

```bash
cd apps/web && npm test && npm run typecheck
```
Expected: 62 pass.

Break: remove the `item_count > 0` guard on Delete and confirm the test fails.
Restore.

```bash
git add apps/web && git commit -m "feat(web): permissions modal and admin surfaces"
```

---

### Task 12: End-to-end flows

**Files:**
- Create: `apps/web/playwright.config.ts`
- Create: `apps/web/e2e/flows.spec.ts`
- Create: `apps/web/e2e/fixtures.ts`

**These are the tests that justify themselves**: each spans the upload handshake,
the API, and real S3, and none can be verified from a component test.

- [ ] **Step 1: Install and configure Playwright**

```bash
cd apps/web
npm i -D @playwright/test
npx playwright install chromium
```

```ts
// playwright.config.ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  use: { baseURL: "http://localhost:5183", trace: "on-first-retry" },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5183",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
```

Add `"e2e": "playwright test"` to `package.json` scripts.

**Prerequisites, stated so a failure is diagnosable rather than mysterious:**
Postgres (5442) and MinIO (9200) up via `docker compose up -d`; the API running
on 3011 (`cd apps/api && bun run start`); at least one admin user
(`bun run seed:admin admin@hdrive.local hunter2hunter2 Admin`); and one storage
backend configured with `hdrive` as the write target.

- [ ] **Step 2: Write `apps/web/e2e/fixtures.ts`**

```ts
import { expect, type Page } from "@playwright/test";

export const ADMIN = { email: "admin@hdrive.local", password: "hunter2hunter2" };

export async function signIn(page: Page, who = ADMIN) {
  await page.goto("/signin");
  await page.getByLabel(/email/i).fill(who.email);
  await page.getByLabel(/password/i).fill(who.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/signin/);
}
```

- [ ] **Step 3: Write `apps/web/e2e/flows.spec.ts`**

```ts
import { expect, test } from "@playwright/test";
import { signIn } from "./fixtures";

test("upload: a file goes through reserve, PUT, and finish, then appears", async ({ page }) => {
  await signIn(page);
  const name = `e2e-${Date.now()}.txt`;

  await page.setInputFiles('input[type="file"]', {
    name, mimeType: "text/plain", buffer: Buffer.from("hello from playwright"),
  });

  // The finishing state must be observable — it is the whole reason it exists.
  await expect(page.getByText(/finishing/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("link", { name })).toBeVisible({ timeout: 15_000 });

  // Size comes from storage, so it must be the real byte length.
  await expect(page.getByText("21 B")).toBeVisible();
});

test("download: the content route returns the bytes that were uploaded", async ({ page }) => {
  await signIn(page);
  const name = `e2e-dl-${Date.now()}.txt`;
  await page.setInputFiles('input[type="file"]', {
    name, mimeType: "text/plain", buffer: Buffer.from("download me"),
  });
  await expect(page.getByRole("link", { name })).toBeVisible({ timeout: 15_000 });

  await page.getByRole("link", { name }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: /download/i }).click(),
  ]);
  expect(download.suggestedFilename()).toBe(name);
});

test("range: the API answers a Range request with 206 and the right slice", async ({ page, request }) => {
  await signIn(page);
  const name = `e2e-range-${Date.now()}.txt`;
  await page.setInputFiles('input[type="file"]', {
    name, mimeType: "text/plain", buffer: Buffer.from("0123456789"),
  });
  await expect(page.getByRole("link", { name })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("link", { name }).click();

  const itemId = page.url().split("/i/")[1];
  const cookies = await page.context().cookies();
  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

  const res = await request.get(`http://localhost:3011/api/items/${itemId}/content`, {
    headers: { range: "bytes=2-5", cookie },
  });
  expect(res.status()).toBe(206);
  expect(res.headers()["content-range"]).toBe("bytes 2-5/10");
  expect(await res.text()).toBe("2345");
});

test("share: create a link, open it signed out, and revoke it", async ({ page, browser }) => {
  await signIn(page);
  const name = `e2e-share-${Date.now()}.txt`;
  await page.setInputFiles('input[type="file"]', {
    name, mimeType: "text/plain", buffer: Buffer.from("shared bytes"),
  });
  await expect(page.getByRole("link", { name })).toBeVisible({ timeout: 15_000 });

  await page.getByRole("row", { name: new RegExp(name) }).getByRole("button", { name: /share/i }).click();
  await page.getByRole("button", { name: /create link/i }).click();
  const url = await page.getByRole("textbox", { name: /link/i }).inputValue();
  expect(url).toContain("/share/");

  // A brand-new context proves the link needs no session.
  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  const res = await anonPage.goto(url);
  expect(res?.status()).toBeLessThan(400);
  await anon.close();

  await page.getByRole("button", { name: /revoke/i }).click();
  const anon2 = await browser.newContext();
  const anonPage2 = await anon2.newPage();
  const after = await anonPage2.goto(url);
  expect(after?.status()).toBe(404);
  await anon2.close();
});

test("trash: delete then restore returns the file to its folder", async ({ page }) => {
  await signIn(page);
  const name = `e2e-trash-${Date.now()}.txt`;
  await page.setInputFiles('input[type="file"]', {
    name, mimeType: "text/plain", buffer: Buffer.from("trash me"),
  });
  await expect(page.getByRole("link", { name })).toBeVisible({ timeout: 15_000 });

  await page.getByRole("row", { name: new RegExp(name) }).getByRole("button", { name: /delete/i }).click();
  await expect(page.getByRole("link", { name })).toBeHidden();

  await page.getByRole("link", { name: /trash/i }).click();
  await page.getByRole("row", { name: new RegExp(name) }).getByRole("button", { name: /restore/i }).click();

  await page.getByRole("link", { name: /my files/i }).click();
  await expect(page.getByRole("link", { name })).toBeVisible();
});
```

- [ ] **Step 4: Run the suite**

```bash
cd apps/api && bun run start &          # API on 3011
cd apps/web && npm run e2e
```

Expected: 5 pass. If the upload test fails at the PUT with a CORS error, that is
**bucket** CORS (not the API's) — configure `PUT` from `http://localhost:5183` on
the MinIO/BiznetGeo bucket. This is the risk named in the spec; if it cannot be
configured, the fallback is proxied uploads and the `StorageBackend` interface
absorbs it.

- [ ] **Step 5: Commit**

```bash
git add apps/web && git commit -m "test(web): end-to-end upload, download, range, share, and trash flows"
```

---

## Final verification

- [ ] **Full stack from clean:**

```bash
docker compose up -d && sleep 10
cd apps/api && bun run migrate && bun test && bun run typecheck
cd ../web && npm test && npm run typecheck && npm run build && npm run e2e
```

- [ ] **Confirm `apps/api` still has zero runtime dependencies:**
      `node -e "if(require('./apps/api/package.json').dependencies) process.exit(1)"`

- [ ] **Confirm the corrected visibility copy** appears nowhere as "Only you":
      `grep -rn "Only you" apps/web/src` must return nothing.

---

## Deferred (not built here)

- **Packages** and **Chat/DMs** — present in the mockup, no backend at all. Each needs its own spec.
- **Search** — the mockup's inputs are placeholders and the API has no endpoint.
- **Bulk actions** — no multi-select in the mockup, no bulk endpoints in the API.
- **Full dark mode** — the mockup defines dark only for the sidebar.
- **Rate limiting** on login and share unlock — an edge-layer concern, named in the backend spec.
