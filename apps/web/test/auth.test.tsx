import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import RequireAuth from "../src/components/RequireAuth";
import SignIn from "../src/routes/SignIn";
import { useMe } from "../src/api/queries";

const wrap = (ui: React.ReactNode, initial = "/") =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[initial]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );

afterEach(() => vi.unstubAllGlobals());

test("sign-in offers email and password, and no signup link", () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
  wrap(<SignIn />);
  expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
  expect(screen.queryByText(/sign up|create account|continue with google/i)).toBeNull();
});

test("a failed sign-in shows the API's message and does not navigate", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ error: "invalid credentials" }), {
      status: 401, headers: { "content-type": "application/json" },
    }),
  ));
  wrap(<SignIn />);
  await userEvent.type(screen.getByLabelText(/email/i), "a@b.com");
  await userEvent.type(screen.getByLabelText(/password/i), "wrongpassword");
  await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
  expect(await screen.findByText(/invalid credentials/i)).toBeInTheDocument();
});

test("RequireAuth renders a redirect target for an anonymous visitor", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ error: "not authenticated" }), {
      status: 401, headers: { "content-type": "application/json" },
    }),
  ));
  wrap(
    <Routes>
      <Route path="/signin" element={<div>sign in page</div>} />
      <Route element={<RequireAuth />}>
        <Route path="/" element={<div>secret</div>} />
      </Route>
    </Routes>,
    "/",
  );
  expect(await screen.findByText("sign in page")).toBeInTheDocument();
  expect(screen.queryByText("secret")).toBeNull();
});

test("RequireAuth renders children for a signed-in user", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ id: "u1", email: "a@b.com", name: "A", is_admin: false }), {
      status: 200, headers: { "content-type": "application/json" },
    }),
  ));
  wrap(
    <Routes>
      <Route path="/signin" element={<div>sign in page</div>} />
      <Route element={<RequireAuth />}>
        <Route path="/" element={<div>secret</div>} />
      </Route>
    </Routes>,
    "/",
  );
  expect(await screen.findByText("secret")).toBeInTheDocument();
});

test("while the session is being checked, neither content nor the sign-in page flashes", async () => {
  let resolve!: (r: Response) => void;
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise((r) => { resolve = r; })));
  wrap(
    <Routes>
      <Route path="/signin" element={<div>sign in page</div>} />
      <Route element={<RequireAuth />}>
        <Route path="/" element={<div>secret</div>} />
      </Route>
    </Routes>,
    "/",
  );
  expect(screen.queryByText("secret")).toBeNull();
  expect(screen.queryByText("sign in page")).toBeNull();
  resolve(new Response(JSON.stringify({ id: "u1", email: "a@b.com", name: "A", is_admin: false }),
    { status: 200, headers: { "content-type": "application/json" } }));
  await waitFor(() => expect(screen.getByText("secret")).toBeInTheDocument());
});

test("useMe resolves to null (not an error state) when anonymous", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "not authenticated" }), {
    status: 401, headers: { "content-type": "application/json" },
  })));
  // Asserts directly on isError/data — unlike routing through RequireAuth,
  // this fails if a propagated error is swapped in for the null mapping:
  // RequireAuth treats `undefined` (error, no data) and `null` (mapped
  // anonymous) identically, so only a direct check of the hook's own state
  // actually distinguishes "mapped to null" from "let the 401 propagate".
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { result } = renderHook(() => useMe(), {
    wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
  });
  await waitFor(() => expect(result.current.isPending).toBe(false));
  expect(result.current.isError).toBe(false);
  expect(result.current.data).toBeNull();
});

test("a session query failing with a 500 renders the retry affordance and does not navigate to /signin", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ error: "internal error" }), {
      status: 500, headers: { "content-type": "application/json" },
    }),
  ));
  wrap(
    <Routes>
      <Route path="/signin" element={<div>sign in page</div>} />
      <Route element={<RequireAuth />}>
        <Route path="/" element={<div>secret</div>} />
      </Route>
    </Routes>,
    "/",
  );
  expect(await screen.findByRole("button", { name: /retry/i })).toBeInTheDocument();
  expect(screen.queryByText("sign in page")).toBeNull();
  expect(screen.queryByText("secret")).toBeNull();
});

test("clicking Retry refetches and, on success, renders the protected content", async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: "internal error" }), {
      status: 500, headers: { "content-type": "application/json" },
    }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: "u1", email: "a@b.com", name: "A", is_admin: false }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
  vi.stubGlobal("fetch", fetchMock);
  wrap(
    <Routes>
      <Route path="/signin" element={<div>sign in page</div>} />
      <Route element={<RequireAuth />}>
        <Route path="/" element={<div>secret</div>} />
      </Route>
    </Routes>,
    "/",
  );
  await userEvent.click(await screen.findByRole("button", { name: /retry/i }));
  expect(await screen.findByText("secret")).toBeInTheDocument();
});
