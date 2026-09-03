import { type FormEvent, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useLogin } from "../api/queries";
import { isApiError } from "../api/errors";
import "../styles/auth.css";

export default function SignIn() {
  const login = useLogin();
  const nav = useNavigate();
  const loc = useLocation() as { state?: { from?: string } };
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate({ email, password }, {
      onSuccess: () => nav(loc.state?.from ?? "/", { replace: true }),
    });
  };

  const message = isApiError(login.error) ? login.error.message : null;

  return (
    <div className="auth">
      <aside className="auth-panel">
        <div className="auth-brand">hdrive</div>
        <h1>Everything your team ships, in one place.</h1>
      </aside>

      <main className="auth-main">
        <form className="auth-card rise" onSubmit={onSubmit} noValidate>
          <h2>Sign in</h2>

          <label htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="username" required
                 value={email} onChange={(e) => setEmail(e.target.value)} />

          <label htmlFor="password">Password</label>
          <input id="password" type="password" autoComplete="current-password" required
                 value={password} onChange={(e) => setPassword(e.target.value)} />

          {message && <p role="alert" className="auth-error">{message}</p>}

          <button type="submit" disabled={login.isPending}>
            {login.isPending ? "Signing in…" : "Sign in"}
          </button>

          <p className="auth-hint">
            Accounts are created by an administrator.
          </p>
        </form>
      </main>
    </div>
  );
}
