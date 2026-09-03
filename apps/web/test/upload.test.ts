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
  // A stale/late onprogress reporting a smaller fraction after a larger one is
  // real XHR behaviour; the bar must never visibly jump backwards.
  for (let i = 1; i < fractions.length; i++) {
    expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1]);
  }
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

  const completeUrl = String(fetchMock.mock.calls[1][0]);
  const completeBody = fetchMock.mock.calls[1][1]?.body;
  const parsed = completeBody ? JSON.parse(completeBody as string) : {};
  expect(parsed.size).toBeUndefined();
  expect(parsed.mime).toBeUndefined();
  // The body isn't the only place size/mime could sneak back in — a regression
  // that moved them into a query string would pass the assertions above while
  // reintroducing the exact quota-bypass/metadata-forgery primitive this test
  // exists to prevent, so the URL must carry no query string at all.
  expect(new URL(completeUrl, "http://x").search).toBe("");
  expect(completeUrl.endsWith("/complete")).toBe(true);
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

test("a caller-supplied AbortSignal cancels the in-flight PUT", async () => {
  const controller = new AbortController();
  class AbortingXhr {
    upload = { onprogress: null as null | ((e: ProgressEvent) => void) };
    onload: null | (() => void) = null;
    onerror: null | (() => void) = null;
    onabort: null | (() => void) = null;
    status = 200;
    open() {}
    setRequestHeader() {}
    send() { controller.abort(); }
    abort() { this.onabort?.(); }
  }
  vi.stubGlobal("XMLHttpRequest", AbortingXhr as unknown as typeof XMLHttpRequest);
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(jsonRes(201, { item_id: "i1", url: "https://s3.test/put", expires_in: 900 })));

  const phases: string[] = [];
  await expect(uploadFile({
    spaceId: "s1", parentId: null, file: file(), signal: controller.signal,
    onPhase: (p) => phases.push(p), onProgress: () => {},
  })).rejects.toBeInstanceOf(ApiError);
  expect(phases).toEqual(["reserving", "uploading", "failed"]);
});
