import { Link, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";

export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-cream flex flex-col">
      <header className="bg-ink text-cream border-b border-gold/20 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link to="/" className="flex flex-col leading-none">
            <span className="font-serif-display text-xl font-bold">Real-time Auction</span>
            <span className="text-[10px] tracking-[0.2em] text-gold uppercase mt-0.5">
              ประมูลออนไลน์แบบเรียลไทม์
            </span>
          </Link>
          <nav className="flex items-center gap-6 text-sm">
            <Link to="/" className="text-cream/80 hover:text-cream transition-colors">
              เรียกดูสินค้า
            </Link>
            {user && (
              <>
                <Link to="/seller" className="text-cream/80 hover:text-cream transition-colors">
                  ลงประมูลสินค้า
                </Link>
                <Link to="/me/bids" className="text-cream/80 hover:text-cream transition-colors">
                  ประวัติของฉัน
                </Link>
              </>
            )}
          </nav>
          <div className="flex items-center gap-3">
            {user ? (
              <>
                <span className="text-sm text-cream/70 hidden sm:inline">{user.display_name}</span>
                <button
                  className="px-3.5 py-1.5 rounded-full text-xs font-semibold border border-cream/30 text-cream hover:bg-cream/10 transition-colors"
                  onClick={() => {
                    logout();
                    navigate("/login");
                  }}
                >
                  ออกจากระบบ
                </button>
              </>
            ) : (
              <>
                <Link
                  to="/login"
                  className="px-4 py-2 text-sm font-medium text-cream/80 hover:text-cream transition-colors"
                >
                  เข้าสู่ระบบ
                </Link>
                <Link
                  to="/register"
                  className="px-3.5 py-1.5 rounded-full text-xs font-semibold bg-gold text-ink hover:bg-gold-dark transition-colors"
                >
                  สมัครสมาชิก
                </Link>
              </>
            )}
          </div>
        </div>
      </header>
      <main className="flex-1 max-w-7xl w-full mx-auto px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}
