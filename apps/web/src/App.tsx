import { Navigate, Route, Routes } from "react-router-dom";
import RequireAuth from "./components/RequireAuth";
import AppShell from "./routes/AppShell";
import Files from "./routes/Files";
import Item from "./routes/Item";
import Settings from "./routes/Settings";
import SignIn from "./routes/SignIn";
import SpaceRedirect from "./routes/SpaceRedirect";
import "./styles/shell.css";

export default function App() {
  return (
    <Routes>
      <Route path="/signin" element={<SignIn />} />
      <Route element={<RequireAuth />}>
        <Route path="/" element={<SpaceRedirect />} />
        <Route element={<AppShell />}>
          {/* Trash and Admin screens are added in Tasks 9-11. */}
          <Route path="/s/:spaceId" element={<Files />} />
          <Route path="/s/:spaceId/f/:itemId" element={<Files />} />
          <Route path="/i/:itemId" element={<Item />} />
          <Route path="/settings" element={<Settings />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
