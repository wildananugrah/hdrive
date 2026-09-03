import { useLogout, useMe } from "../api/queries";
import Avatar from "../components/Avatar";

// The API exposes no profile-update endpoint, so this screen shows the
// signed-in identity and offers sign-out only. Do not add name/email inputs:
// a form the API cannot save would silently discard whatever the user typed.
export default function Settings() {
  const { data: me } = useMe();
  const logout = useLogout();
  if (!me) return null;

  return (
    <div className="settings">
      <h1>Account</h1>
      <div className="settings-identity">
        <Avatar name={me.name} size={48} />
        <div>
          <p className="settings-name">{me.name}</p>
          <p className="mono-label">{me.email}</p>
          {me.is_admin && <span className="pill">Administrator</span>}
        </div>
      </div>
      <p className="settings-hint">
        Your name and email are managed by an administrator.
      </p>
      <button className="btn-danger" onClick={() => logout.mutate()}>Log out</button>
    </div>
  );
}
