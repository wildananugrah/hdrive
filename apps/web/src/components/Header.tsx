import { useLogout } from "../api/queries";
import type { User } from "../api/types";
import Avatar from "./Avatar";

export default function Header({ me, title }: { me: User; title: string }) {
  const logout = useLogout();
  return (
    <header className="header">
      <h1>{title}</h1>
      <div className="header-right">
        <Avatar name={me.name} />
        <span>{me.name}</span>
        <button className="btn-ghost btn-danger" onClick={() => logout.mutate()}>Log out</button>
      </div>
    </header>
  );
}
