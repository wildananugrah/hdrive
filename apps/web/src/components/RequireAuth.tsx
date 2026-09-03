import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useMe } from "../api/queries";
import "../styles/auth.css";

export default function RequireAuth() {
  const { data: me, isPending, isError, refetch } = useMe();
  const loc = useLocation();

  // Render nothing while the session is resolving: showing either the app or
  // the sign-in page here causes a visible flash on every load.
  if (isPending) return null;

  // A transient network/server failure is not a session expiry — bouncing to
  // /signin here would silently log out a user whose network blipped, with
  // no way back. Only a confirmed anonymous session (data === null) redirects.
  if (isError) {
    return (
      <div className="auth-retry" role="alert">
        <p>Couldn't reach the server. Check your connection and try again.</p>
        <button type="button" onClick={() => refetch()}>Retry</button>
      </div>
    );
  }

  if (!me) return <Navigate to="/signin" replace state={{ from: loc.pathname }} />;
  return <Outlet />;
}
