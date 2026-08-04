import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { Bid } from "../types";
import { formatMoney } from "../lib/format";

export function MyBids() {
  const [bids, setBids] = useState<Bid[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<Bid[]>("/me/bids")
      .then((data) => setBids(data ?? []))
      .catch(() => setError("ไม่สามารถโหลดประวัติการประมูลได้"));
  }, []);

  return (
    <div className="max-w-3xl mx-auto">
      <p className="text-[10px] tracking-[0.2em] text-gold-dark uppercase mb-1">ของฉัน</p>
      <h1 className="font-serif-display text-2xl font-bold text-ink mb-6">ประวัติการเสนอราคา</h1>
      {error && <p className="text-red-600 mb-4">{error}</p>}
      <div className="rounded-xl border border-slate-100 bg-white shadow-card overflow-hidden">
        <table className="w-full text-sm text-left">
          <thead className="bg-paper text-ink-muted text-xs uppercase tracking-wider">
            <tr>
              <th className="px-4 py-2.5">สินค้า</th>
              <th className="px-4 py-2.5">จำนวนเงิน</th>
              <th className="px-4 py-2.5">สถานะ</th>
              <th className="px-4 py-2.5">เวลา</th>
            </tr>
          </thead>
          <tbody>
            {bids.map((b) => (
              <tr key={b.id} className="border-t border-slate-100">
                <td className="px-4 py-2.5">
                  <Link className="text-gold-dark font-medium hover:underline" to={`/auctions/${b.item_id}`}>
                    {b.item_title}
                  </Link>
                </td>
                <td className="px-4 py-2.5 font-mono-digits">{formatMoney(b.amount)}</td>
                <td className={`px-4 py-2.5 font-medium ${b.status === "accepted" ? "text-emerald-600" : "text-red-500"}`}>
                  {b.status === "accepted" ? "สูงสุด" : "ถูกปฏิเสธ"}
                  {b.reason ? ` (${b.reason})` : ""}
                </td>
                <td className="px-4 py-2.5 text-ink-muted">{new Date(b.created_at).toLocaleString()}</td>
              </tr>
            ))}
            {bids.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-ink-muted">
                  คุณยังไม่ได้เสนอราคาสินค้าใดๆ
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
