import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useMe } from "../api/queries";

export default function RequireAuth() {
  const { data: me, isPending } = useMe();
  const loc = useLocation();

  // Render nothing while the session is resolving: showing either the app or
  // the sign-in page here causes a visible flash on every load.
  if (isPending) return null;
  if (!me) return <Navigate to="/signin" replace state={{ from: loc.pathname }} />;
  return <Outlet />;
}
