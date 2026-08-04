import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { ApiError } from "../lib/api";

export function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await register(email, password, displayName);
      navigate("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Registration failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-sm mx-auto mt-12">
      <h1 className="text-2xl font-semibold mb-6">Create an account</h1>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <input
          className="rounded bg-slate-900 border border-slate-700 px-3 py-2"
          placeholder="Display name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          required
        />
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
          placeholder="Password (min 6 characters)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={6}
          required
        />
        {error && <p className="text-red-400 text-sm">{error}</p>}
        <button
          disabled={busy}
          className="rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 px-3 py-2 font-medium"
        >
          {busy ? "Creating account..." : "Register"}
        </button>
      </form>
      <p className="text-sm text-slate-400 mt-4">
        Already have an account? <Link className="text-emerald-400" to="/login">Log in</Link>
      </p>
    </div>
  );
}
