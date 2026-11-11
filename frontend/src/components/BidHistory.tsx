import { useMemo, useState } from "react";
import type { Bid } from "../types";
import { formatMoney } from "../lib/format";
import { bidderOf, filterAndSortBids, formatPct, type BidSort, type BidStats } from "../lib/bidStats";

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("th-TH", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function timeAgo(iso: string, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - new Date(iso).getTime()) / 1000));
  if (s < 5) return "เมื่อสักครู่";
  if (s < 60) return `${s} วินาทีที่แล้ว`;
  if (s < 3600) return `${Math.floor(s / 60)} นาทีที่แล้ว`;
  if (s < 86400) return `${Math.floor(s / 3600)} ชั่วโมงที่แล้ว`;
  return `${Math.floor(s / 86400)} วันที่แล้ว`;
}

// A colored circle with the first letter of the (masked) name. The color
// follows the bidder, so one person's bids are easy to spot down the table.
const AVATAR_COLORS = ["bg-amber-500", "bg-emerald-600", "bg-sky-600", "bg-rose-500", "bg-violet-600", "bg-teal-600", "bg-orange-500", "bg-indigo-500"];
function Avatar({ bid, size = "w-8 h-8 text-sm" }: { bid: Bid; size?: string }) {
  const key = bidderOf(bid);
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const initial = Array.from(bid.user_name ?? "?")[0] ?? "?";
  return (
    <span
      className={`${size} ${AVATAR_COLORS[h % AVATAR_COLORS.length]} shrink-0 rounded-full text-white font-semibold grid place-items-center`}
      aria-hidden
    >
      {initial.toUpperCase()}
    </span>
  );
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-slate-100 bg-white shadow-card px-4 py-3">
      <p className="text-[11px] uppercase tracking-wider text-ink-muted">{label}</p>
      <p className="font-mono-digits text-xl sm:text-2xl font-bold text-ink mt-1 truncate">{value}</p>
      {hint && <p className="text-[11px] text-ink-muted mt-0.5">{hint}</p>}
    </div>
  );
}

export function BidStatCards({ stats, startingPrice }: { stats: BidStats; startingPrice: number }) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <StatCard label="จำนวนการเสนอราคา" value={stats.bidCount.toLocaleString()} hint="ครั้ง" />
      <StatCard label="ผู้เข้าร่วมประมูล" value={stats.bidderCount.toLocaleString()} hint="คน" />
      <StatCard label="ราคาเพิ่มขึ้น" value={formatPct(stats.increasePct)} hint={`จากราคาเริ่มต้น ${formatMoney(startingPrice)}`} />
      <StatCard label="ราคาสูงสุด" value={stats.highest !== null ? formatMoney(stats.highest) : "–"} />
    </div>
  );
}

const SORT_LABELS: Record<BidSort, string> = {
  amount_desc: "ราคา: สูง → ต่ำ",
  amount_asc: "ราคา: ต่ำ → สูง",
  time_desc: "เวลา: ล่าสุดก่อน",
  time_asc: "เวลา: เก่าสุดก่อน",
};

// Accepted bids ranked by amount (rank 1 = the leading / winning bid), with
// a name search and a sort choice. leaderId gets the "สูงสุด"/"ชนะ" badge.
export function BidHistoryTable({
  bids,
  leaderId,
  leaderLabel = "สูงสุด",
}: {
  bids: Bid[];
  leaderId: string | null;
  leaderLabel?: string;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<BidSort>("amount_desc");

  // rank by amount regardless of how the table is currently sorted
  const rankOf = useMemo(() => {
    const m = new Map<string, number>();
    filterAndSortBids(bids, "", "amount_desc").forEach((b, i) => m.set(b.id, i + 1));
    return m;
  }, [bids]);
  const rows = useMemo(() => filterAndSortBids(bids, query, sort), [bids, query, sort]);

  return (
    <div className="rounded-xl border border-slate-100 bg-white shadow-card overflow-hidden">
      <div className="flex flex-col sm:flex-row gap-2 p-3 border-b border-slate-100">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="ค้นหาชื่อผู้ประมูล"
          className="flex-1 rounded-md bg-cream border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold/40"
        />
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as BidSort)}
          aria-label="เรียงลำดับ"
          className="rounded-md bg-cream border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold/40"
        >
          {Object.entries(SORT_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <div className="max-h-[28rem] overflow-y-auto">
        <table className="w-full text-sm text-left">
          <thead className="bg-paper text-ink-muted text-xs uppercase tracking-wider sticky top-0">
            <tr>
              <th className="px-4 py-2.5 w-14">อันดับ</th>
              <th className="px-4 py-2.5">ผู้ประมูล</th>
              <th className="px-4 py-2.5 text-right">จำนวนเงิน</th>
              <th className="px-4 py-2.5 hidden sm:table-cell">วันที่ / เวลา</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => {
              const lead = b.id === leaderId;
              return (
                <tr key={b.id} className={`border-t border-slate-100 ${lead ? "bg-gold/10" : ""}`}>
                  <td className="px-4 py-2.5 font-mono-digits text-ink-muted">#{rankOf.get(b.id)}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <Avatar bid={b} />
                      <span className="text-ink">{b.user_name}</span>
                      {lead && (
                        <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-semibold">
                          {leaderLabel}
                        </span>
                      )}
                    </div>
                    <p className="sm:hidden text-[11px] text-ink-muted mt-1 pl-10">{formatDateTime(b.created_at)}</p>
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono-digits font-semibold text-ink">{formatMoney(b.amount)}</td>
                  <td className="px-4 py-2.5 text-ink-muted hidden sm:table-cell whitespace-nowrap">{formatDateTime(b.created_at)}</td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-ink-muted">
                  {query ? "ไม่พบผู้ประมูลที่ค้นหา" : "ยังไม่มีการเสนอราคา"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Newest accepted bids as they arrive over the WebSocket.
export function LiveBidFeed({ bids, nowMs, connected }: { bids: Bid[]; nowMs: number; connected: boolean }) {
  const recent = useMemo(() => filterAndSortBids(bids, "", "time_desc").slice(0, 12), [bids]);
  return (
    <div className="rounded-xl border border-slate-100 bg-white shadow-card overflow-hidden h-fit">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
        <h3 className="font-serif-display font-semibold text-ink">การเสนอราคาสด</h3>
        <span className="flex items-center gap-1.5 text-[11px] text-ink-muted">
          <span className={`w-2 h-2 rounded-full ${connected ? "bg-red-500 animate-pulse" : "bg-slate-300"}`} />
          {connected ? "LIVE" : "กำลังเชื่อมต่อ"}
        </span>
      </div>
      <ul className="max-h-[28rem] overflow-y-auto divide-y divide-slate-100">
        {recent.map((b, i) => (
          <li key={b.id} className={`flex items-center gap-3 px-4 py-2.5 ${i === 0 ? "animate-[fadeIn_0.4s_ease-out]" : ""}`}>
            <Avatar bid={b} size="w-7 h-7 text-xs" />
            <div className="flex-1 min-w-0">
              <p className="text-sm text-ink truncate">
                {b.user_name} <span className="text-ink-muted">เสนอราคา</span>
              </p>
              <p className="text-[11px] text-ink-muted">{timeAgo(b.created_at, nowMs)}</p>
            </div>
            <span className="font-mono-digits text-sm font-semibold text-emerald-700">{formatMoney(b.amount)}</span>
          </li>
        ))}
        {recent.length === 0 && <li className="px-4 py-8 text-center text-sm text-ink-muted">รอการเสนอราคาแรก…</li>}
      </ul>
    </div>
  );
}
