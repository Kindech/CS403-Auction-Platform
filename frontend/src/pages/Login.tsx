import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { ApiError } from "../lib/api";

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("bidder@example.com");
  const [password, setPassword] = useState("password123");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email, password);
      navigate("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-sm mx-auto mt-12">
      <h1 className="text-2xl font-semibold mb-6">Log in</h1>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <input
          className="rounded bg-slate-900 border border-slate-700 px-3 py-2"
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          className="rounded bg-slate-900 border border-slate-700 px-3 py-2"
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {error && <p className="text-red-400 text-sm">{error}</p>}
        <button
          disabled={busy}
          className="rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 px-3 py-2 font-medium"
        >
          {busy ? "Logging in..." : "Log in"}
        </button>
      </form>
      <p className="text-sm text-slate-400 mt-4">
        No account? <Link className="text-emerald-400" to="/register">Register</Link>
      </p>
      <p className="text-xs text-slate-500 mt-6">
        Demo accounts: seller@example.com / bidder@example.com, password "password123"
      </p>
    </div>
  );
}
