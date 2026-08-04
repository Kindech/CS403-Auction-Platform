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
    <div className="max-w-sm mx-auto mt-8 bg-white rounded-xl shadow-card border border-slate-100 p-8">
      <p className="text-[10px] tracking-[0.2em] text-gold-dark uppercase mb-1">เข้าร่วมกับเรา</p>
      <h1 className="font-serif-display text-2xl font-bold text-ink mb-6">สมัครสมาชิก</h1>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <input
          className="rounded-md bg-cream border border-slate-200 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold/40"
          placeholder="ชื่อที่แสดง"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          required
        />
        <input
          className="rounded-md bg-cream border border-slate-200 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold/40"
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          className="rounded-md bg-cream border border-slate-200 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold/40"
          type="password"
          placeholder="รหัสผ่าน (อย่างน้อย 6 ตัวอักษร)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={6}
          required
        />
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <button
          disabled={busy}
          className="rounded-full bg-ink text-cream hover:bg-ink/90 disabled:opacity-50 px-4 py-2.5 font-semibold text-sm transition-colors"
        >
          {busy ? "กำลังสมัคร..." : "สมัครสมาชิก"}
        </button>
      </form>
      <p className="text-sm text-ink-muted mt-5">
        มีบัญชีอยู่แล้ว?{" "}
        <Link className="text-gold-dark font-medium hover:underline" to="/login">
          เข้าสู่ระบบ
        </Link>
      </p>
    </div>
  );
}
