import { Navigate, Route, Routes } from "react-router-dom";
import RequireAuth from "./components/RequireAuth";
import AppShell from "./routes/AppShell";
import Files from "./routes/Files";
import Item from "./routes/Item";
import Settings from "./routes/Settings";
import SignIn from "./routes/SignIn";
import SpaceRedirect from "./routes/SpaceRedirect";
import Trash from "./routes/Trash";
import Unlock from "./routes/share/Unlock";
import Backends from "./routes/admin/Backends";
import Groups from "./routes/admin/Groups";
import Users from "./routes/admin/Users";
import "./styles/shell.css";

export default function App() {
  return (
    <Routes>
      <Route path="/signin" element={<SignIn />} />
      {/* Public: a share recipient is not signed in, so this must stay
          outside RequireAuth — inside it, public sharing would break
          entirely while every existing (authenticated) test still passed. */}
      <Route path="/share/:token" element={<Unlock />} />
      <Route element={<RequireAuth />}>
        <Route path="/" element={<SpaceRedirect />} />
        <Route element={<AppShell />}>
          <Route path="/s/:spaceId" element={<Files />} />
          <Route path="/s/:spaceId/f/:itemId" element={<Files />} />
          <Route path="/s/:spaceId/trash" element={<Trash />} />
          <Route path="/i/:itemId" element={<Item />} />
          <Route path="/settings" element={<Settings />} />
          {/* requireAdmin enforces this server-side regardless; each screen
              also guards on me.is_admin so a forced URL renders a Forbidden
              state instead of a broken admin page. */}
          <Route path="/admin/backends" element={<Backends />} />
          <Route path="/admin/users" element={<Users />} />
          <Route path="/admin/groups" element={<Groups />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
