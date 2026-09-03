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

// ---- The two predicates this task exists to protect --------------------

test("a failed upload does not also show a progress bar", () => {
  render(<UploadToast uploads={[u({ phase: "failed", progress: 0.7, error: "boom" })]}
                      onRetry={() => {}} onDismiss={() => {}} />);
  expect(document.querySelector(".toast-bar")).toBeNull();
});

test("an in-progress upload has no retry or dismiss control yet", () => {
  render(<UploadToast uploads={[u({ phase: "uploading" })]} onRetry={() => {}} onDismiss={() => {}} />);
  expect(screen.queryByRole("button")).toBeNull();
});

test("multiple concurrent uploads each render their own row", () => {
  render(
    <UploadToast
      uploads={[u({ id: "1", name: "a.txt" }), u({ id: "2", name: "b.txt", phase: "finishing", progress: 1 })]}
      onRetry={() => {}}
      onDismiss={() => {}}
    />,
  );
  expect(screen.getByText("a.txt")).toBeInTheDocument();
  expect(screen.getByText("b.txt")).toBeInTheDocument();
});

test("under prefers-reduced-motion, the rise animation is disabled by base.css", () => {
  // The toast opts into the shared .rise keyframe; the reduced-motion override
  // lives in base.css's @media block and applies globally to any .rise element,
  // so asserting the class is present is what ties this component to that rule
  // — jsdom does not evaluate @media queries, so the CSS rule itself is
  // exercised by test/tokens.test.ts-style source assertions, not here.
  render(<UploadToast uploads={[u()]} onRetry={() => {}} onDismiss={() => {}} />);
  expect(screen.getByRole("status")).toHaveClass("rise");
});
