import type { Bid, Item } from "../types";
import { formatMoney } from "../lib/format";

export function WinnerAnnouncement({
  item,
  winnerName,
  finalPrice,
  bids,
}: {
  item: Item;
  winnerName: string | null;
  finalPrice: number | null;
  bids: Bid[];
}) {
  const hasWinner = !!winnerName;
  return (
    <div className="max-w-2xl mx-auto text-center">
      <div className="bg-ink text-cream rounded-xl p-10 mb-8">
        <p className="text-[10px] tracking-[0.2em] text-gold uppercase mb-3">การประมูลสิ้นสุดแล้ว</p>
        <h1 className="font-serif-display text-3xl font-bold mb-6">{item.title}</h1>
        {hasWinner ? (
          <>
            <p className="text-cream/70 text-sm">ผู้ชนะ</p>
            <p className="text-2xl font-serif-display font-bold text-gold mb-4">{winnerName}</p>
            <p className="text-cream/70 text-sm">ราคาสุดท้าย</p>
            <p className="font-mono-digits text-4xl font-bold">{formatMoney(finalPrice ?? item.starting_price)}</p>
          </>
        ) : (
          <p className="text-cream/70">ไม่มีผู้เสนอราคา - สินค้านี้ไม่มีการขาย</p>
        )}
      </div>

      <h2 className="text-lg font-serif-display font-semibold text-ink mb-3 text-left">ประวัติการเสนอราคา</h2>
      <div className="rounded-xl border border-slate-100 bg-white shadow-card overflow-hidden">
        <table className="w-full text-sm text-left">
          <thead className="bg-paper text-ink-muted text-xs uppercase tracking-wider">
            <tr>
              <th className="px-4 py-2.5">ผู้เสนอราคา</th>
              <th className="px-4 py-2.5">จำนวนเงิน</th>
              <th className="px-4 py-2.5">สถานะ</th>
              <th className="px-4 py-2.5">เวลา</th>
            </tr>
          </thead>
          <tbody>
            {bids.map((b) => (
              <tr key={b.id} className="border-t border-slate-100">
                <td className="px-4 py-2.5">{b.user_name}</td>
                <td className="px-4 py-2.5 font-mono-digits">{formatMoney(b.amount)}</td>
                <td className={`px-4 py-2.5 font-medium ${b.status === "accepted" ? "text-emerald-600" : "text-red-500"}`}>
                  {b.status === "accepted" ? "ชนะ" : "ถูกปฏิเสธ"}
                </td>
                <td className="px-4 py-2.5 text-ink-muted">{new Date(b.created_at).toLocaleTimeString()}</td>
              </tr>
            ))}
            {bids.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-ink-muted">
                  ยังไม่มีการเสนอราคา
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
