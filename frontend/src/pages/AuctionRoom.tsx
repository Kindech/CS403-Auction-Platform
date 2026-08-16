import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../lib/api";
import { useAuctionSocket } from "../lib/useAuctionSocket";
import { useAuth } from "../lib/auth";
import type { Bid, Item } from "../types";
import { formatMoney, formatCountdown } from "../lib/format";
import { WinnerAnnouncement } from "../components/WinnerAnnouncement";

const REJECT_MESSAGES: Record<string, string> = {
  bid_too_low: "ราคาที่เสนอต่ำกว่าราคาขั้นต่ำในขณะนี้ (มีคนเสนอราคาสูงกว่าไปแล้ว) กรุณาตรวจสอบราคาล่าสุดแล้วลองใหม่",
  auction_not_live: "การประมูลนี้ยังไม่เปิดหรือปิดรับการเสนอราคาแล้ว",
  auction_closed: "การประมูลนี้สิ้นสุดลงแล้ว",
  rate_limited: "คุณเสนอราคาถี่เกินไป กรุณารอสักครู่แล้วลองใหม่",
};

export function AuctionRoom() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const [item, setItem] = useState<Item | null>(null);
  const [bids, setBids] = useState<Bid[]>([]);
  const [amount, setAmount] = useState<string>("");
  const [now, setNow] = useState(() => Date.now());
  const [popup, setPopup] = useState<string | null>(null);

  const { state, sendBid } = useAuctionSocket(id);

  useEffect(() => {
    if (!id) return;
    api.get<Item>(`/items/${id}`).then(setItem).catch(() => {});
  }, [id]);

  // The item may still be "upcoming" when the page loads. Once the client
  // clock reaches start_time, poll until bid-worker's lifecycle tick (every
  // ~1s) actually activates it in Postgres/Redis and flips its status.
  useEffect(() => {
    if (!id || !item || item.status !== "upcoming") return;
    if (now < new Date(item.start_time).getTime()) return;
    api.get<Item>(`/items/${id}`).then(setItem).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now, id, item?.status, item?.start_time]);

  useEffect(() => {
    if (!popup) return;
    const t = setTimeout(() => setPopup(null), 5000);
    return () => clearTimeout(t);
  }, [popup]);

  useEffect(() => {
    if (!state.lastRejectReason) return;
    setPopup(REJECT_MESSAGES[state.lastRejectReason] ?? `การเสนอราคาถูกปฏิเสธ: ${state.lastRejectReason}`);
  }, [state.lastRejectReason]);

  async function refreshBids() {
    if (!id) return;
    try {
      setBids((await api.get<Bid[]>(`/items/${id}/bids`)) ?? []);
    } catch {
      // best-effort refresh; ignore transient failures
    }
  }

  useEffect(() => {
    refreshBids();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // New bids come straight from the WS broadcast, not a Postgres refetch:
  // bid-worker's audit insert is an async batch, so refetching here would
  // race it and the table would show stale/empty history.
  useEffect(() => {
    if (!state.latestBid) return;
    setBids((prev) => [state.latestBid!, ...prev]);
  }, [state.latestBid]);

  // Once the auction ends, reconcile with the authoritative Postgres record
  // (by then bid-worker's final batch has long since flushed).
  useEffect(() => {
    if (!state.ended) return;
    refreshBids();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.ended]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!item) return <p className="text-ink-muted">กำลังโหลด...</p>;

  const rejectPopup = popup && (
    <div className="fixed inset-x-0 top-6 z-50 flex justify-center px-4">
      <div className="max-w-md w-full rounded-xl border border-red-200 bg-white shadow-card-hover px-4 py-3 flex items-start gap-3">
        <span className="text-red-500 mt-0.5" aria-hidden>
          ⚠️
        </span>
        <p className="text-sm text-ink flex-1">{popup}</p>
        <button onClick={() => setPopup(null)} className="text-ink-muted hover:text-ink text-sm" aria-label="ปิด">
          ✕
        </button>
      </div>
    </div>
  );

  const ended = item.status === "ended" || state.ended;
  if (ended) {
    return (
      <WinnerAnnouncement
        item={item}
        winnerName={state.winnerName ?? item.winner_name ?? null}
        finalPrice={state.finalPrice ?? item.final_price ?? null}
        bids={bids}
      />
    );
  }

  if (item.status === "upcoming") {
    const startTimeMs = new Date(item.start_time).getTime();
    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div>
          <div className="relative aspect-4/3 bg-paper rounded-xl overflow-hidden mb-4 border border-slate-100">
            {item.image_url && (
              <img src={item.image_url} alt={item.title} className="w-full h-full object-cover" />
            )}
            <span className="absolute top-3 left-3 inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold border backdrop-blur-sm bg-blue-50 text-blue-700 border-blue-200">
              เร็วๆ นี้
            </span>
          </div>
          <h1 className="font-serif-display text-2xl font-bold text-ink">{item.title}</h1>
          <p className="text-ink-muted mt-2 text-sm">{item.description}</p>
          <p className="text-xs text-ink-muted/70 mt-3">ผู้ขาย: {item.seller_name}</p>
        </div>

        <div className="rounded-xl border border-slate-100 bg-white shadow-card p-6 text-center h-fit">
          <p className="text-[10px] uppercase tracking-wider text-ink-muted">ราคาเริ่มต้น</p>
          <p className="font-mono-digits text-4xl font-bold text-ink my-2">{formatMoney(item.starting_price)}</p>
          <p className="text-sm text-ink-muted mb-4">ยังไม่เปิดรับการเสนอราคา</p>
          <p className="text-[10px] uppercase tracking-wider text-ink-muted mb-1">เริ่มประมูลใน</p>
          <p className="font-mono-digits text-xl font-bold text-gold-dark">{formatCountdown(startTimeMs, now)}</p>
        </div>
      </div>
    );
  }

  const currentPrice = state.price ?? item.current_price;
  const minIncrement = state.minIncrement ?? item.bid_increment;
  const minNextBid = currentPrice + minIncrement;
  const endTimeMs = state.endTimeMs ?? new Date(item.end_time).getTime();

  function placeBid() {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      setPopup("กรุณาระบุจำนวนเงินที่ต้องการเสนอราคาให้ถูกต้อง");
      return;
    }
    if (value < minNextBid) {
      setPopup(`ราคาที่เสนอต้องไม่ต่ำกว่าราคาขั้นต่ำในขณะนี้ คือ ${formatMoney(minNextBid)}`);
      return;
    }
    sendBid(value);
    setAmount("");
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
      {rejectPopup}
      <div>
        <div className="relative aspect-4/3 bg-paper rounded-xl overflow-hidden mb-4 border border-slate-100">
          {item.image_url && (
            <img src={item.image_url} alt={item.title} className="w-full h-full object-cover" />
          )}
          {item.status === "live" && (
            <span className="absolute top-3 right-3 px-2 py-1 rounded-full bg-ink/80 text-cream text-[10px] backdrop-blur-sm flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
              LIVE
            </span>
          )}
        </div>
        <h1 className="font-serif-display text-2xl font-bold text-ink">{item.title}</h1>
        <p className="text-ink-muted mt-2 text-sm">{item.description}</p>
        <p className="text-xs text-ink-muted/70 mt-3">
          ผู้ขาย: {item.seller_name} · {state.connected ? "🟢 เชื่อมต่อสด" : "🟠 กำลังเชื่อมต่อใหม่..."}
        </p>
      </div>

      <div>
        <div className="rounded-xl border border-slate-100 bg-white shadow-card p-6 text-center mb-6">
          <p className="text-[10px] uppercase tracking-wider text-ink-muted">ราคาปัจจุบัน</p>
          <p className="font-mono-digits text-4xl font-bold text-ink my-2">{formatMoney(currentPrice)}</p>
          <p className="text-sm text-ink-muted mb-4">
            {state.bidderName ? (
              <>
                ผู้เสนอราคาสูงสุด: <span className="text-ink font-medium">{state.bidderName}</span>
              </>
            ) : (
              "ยังไม่มีผู้เสนอราคา"
            )}
          </p>
          <p className="text-[10px] uppercase tracking-wider text-ink-muted mb-1">สิ้นสุดประมูลใน</p>
          <p className="font-mono-digits text-xl font-bold text-gold-dark">{formatCountdown(endTimeMs, now)}</p>

          {user ? (
            <div className="mt-6 flex gap-2">
              <input
                type="number"
                className="flex-1 rounded-md bg-cream border border-slate-200 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold/40"
                placeholder={`ขั้นต่ำ ${formatMoney(minNextBid)}`}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                min={minNextBid}
                step={minIncrement}
              />
              <button
                onClick={placeBid}
                className="rounded-full bg-gold text-ink hover:bg-gold-dark font-semibold px-5 py-2.5 text-sm transition-colors"
              >
                เสนอราคา
              </button>
            </div>
          ) : (
            <p className="mt-6 text-sm text-ink-muted">เข้าสู่ระบบเพื่อเสนอราคา</p>
          )}
          {state.lastRejectReason && (
            <p className="text-red-600 text-sm mt-3">ถูกปฏิเสธ: {state.lastRejectReason}</p>
          )}
        </div>

        <h2 className="text-lg font-serif-display font-semibold text-ink mb-3">ประวัติการเสนอราคาแบบเรียลไทม์</h2>
        <div className="max-h-80 overflow-y-auto rounded-xl border border-slate-100 bg-white shadow-card">
          <table className="w-full text-sm text-left">
            <thead className="bg-paper text-ink-muted text-xs uppercase tracking-wider sticky top-0">
              <tr>
                <th className="px-4 py-2.5">ผู้เสนอราคา</th>
                <th className="px-4 py-2.5">จำนวนเงิน</th>
                <th className="px-4 py-2.5">สถานะ</th>
              </tr>
            </thead>
            <tbody>
              {bids.map((b) => (
                <tr key={b.id} className="border-t border-slate-100">
                  <td className="px-4 py-2.5">{b.user_name}</td>
                  <td className="px-4 py-2.5 font-mono-digits">{formatMoney(b.amount)}</td>
                  <td className={`px-4 py-2.5 font-medium ${b.status === "accepted" ? "text-emerald-600" : "text-red-500"}`}>
                    {b.status === "accepted" ? "สูงสุด" : "ถูกแซง/ปฏิเสธ"}
                  </td>
                </tr>
              ))}
              {bids.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-6 text-center text-ink-muted">
                    ยังไม่มีการเสนอราคา
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
