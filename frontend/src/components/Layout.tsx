import { Link, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";

export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="min-h-full flex flex-col">
      <header className="border-b border-slate-800 px-6 py-3 flex items-center justify-between">
        <Link to="/" className="text-lg font-semibold text-emerald-400">
          Real-time Auction
        </Link>
        <nav className="flex items-center gap-4 text-sm">
          <Link to="/" className="hover:text-emerald-400">Dashboard</Link>
          {user && (
            <>
              <Link to="/seller" className="hover:text-emerald-400">Seller Tools</Link>
              <Link to="/me/bids" className="hover:text-emerald-400">My Bids</Link>
              <span className="text-slate-400">{user.display_name}</span>
              <button
                className="rounded bg-slate-800 px-3 py-1 hover:bg-slate-700"
                onClick={() => {
                  logout();
                  navigate("/login");
                }}
              >
                Log out
              </button>
            </>
          )}
          {!user && (
            <>
              <Link to="/login" className="hover:text-emerald-400">Login</Link>
              <Link to="/register" className="hover:text-emerald-400">Register</Link>
            </>
          )}
        </nav>
      </header>
      <main className="flex-1 px-6 py-6">
        <Outlet />
      </main>
    </div>
  );
}
