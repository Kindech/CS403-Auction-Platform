import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../lib/api";
import { useAuctionSocket } from "../lib/useAuctionSocket";
import { useAuth } from "../lib/auth";
import type { Bid, Item } from "../types";
import { formatMoney, formatCountdown } from "../lib/format";
import { WinnerAnnouncement } from "../components/WinnerAnnouncement";

export function AuctionRoom() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const [item, setItem] = useState<Item | null>(null);
  const [bids, setBids] = useState<Bid[]>([]);
  const [amount, setAmount] = useState<string>("");
  const [now, setNow] = useState(() => Date.now());

  const { state, sendBid } = useAuctionSocket(id);

  useEffect(() => {
    if (!id) return;
    api.get<Item>(`/items/${id}`).then(setItem).catch(() => {});
  }, [id]);

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

  useEffect(() => {
    refreshBids();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.price, state.ended]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!item) return <p className="text-slate-400">Loading auction...</p>;

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

  const currentPrice = state.price ?? item.current_price;
  const minIncrement = state.minIncrement ?? item.bid_increment;
  const minNextBid = currentPrice + minIncrement;
  const endTimeMs = state.endTimeMs ?? new Date(item.end_time).getTime();

  function placeBid() {
    const value = Number(amount);
    if (!Number.isFinite(value) || value < minNextBid) return;
    sendBid(value);
    setAmount("");
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 max-w-5xl mx-auto">
      <div>
        <div className="aspect-video bg-slate-800 rounded-lg overflow-hidden mb-4">
          {item.image_url && (
            <img src={item.image_url} alt={item.title} className="w-full h-full object-cover" />
          )}
        </div>
        <h1 className="text-2xl font-semibold">{item.title}</h1>
        <p className="text-slate-400 mt-1">{item.description}</p>
        <p className="text-xs text-slate-500 mt-2">
          Seller: {item.seller_name} · {state.connected ? "🟢 live" : "🟠 reconnecting..."}
        </p>
      </div>

      <div>
        <div className="rounded-lg border border-slate-800 bg-slate-900 p-6 text-center mb-6">
          <p className="text-sm text-slate-400 uppercase tracking-wide">Current price</p>
          <p className="text-4xl font-bold my-2">{formatMoney(currentPrice)}</p>
          <p className="text-sm text-slate-400 mb-4">
            {state.bidderName ? `Highest bidder: ${state.bidderName}` : "No bids yet"}
          </p>
          <p className="text-xl font-mono text-emerald-400">{formatCountdown(endTimeMs, now)}</p>

          {user ? (
            <div className="mt-6 flex gap-2">
              <input
                type="number"
                className="flex-1 rounded bg-slate-800 border border-slate-700 px-3 py-2"
                placeholder={`Min ${formatMoney(minNextBid)}`}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                min={minNextBid}
                step={minIncrement}
              />
              <button
                onClick={placeBid}
                className="rounded bg-emerald-600 hover:bg-emerald-500 px-4 py-2 font-medium"
              >
                Bid
              </button>
            </div>
          ) : (
            <p className="mt-6 text-sm text-slate-400">Log in to place a bid.</p>
          )}
          {state.lastRejectReason && (
            <p className="text-red-400 text-sm mt-3">Rejected: {state.lastRejectReason}</p>
          )}
        </div>

        <h2 className="text-lg font-medium mb-3">Live bid history</h2>
        <div className="max-h-80 overflow-y-auto rounded border border-slate-800">
          <table className="w-full text-sm text-left">
            <thead className="bg-slate-900 text-slate-400 sticky top-0">
              <tr>
                <th className="px-3 py-2">Bidder</th>
                <th className="px-3 py-2">Amount</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {bids.map((b) => (
                <tr key={b.id} className="border-t border-slate-800">
                  <td className="px-3 py-2">{b.user_name}</td>
                  <td className="px-3 py-2">{formatMoney(b.amount)}</td>
                  <td className={`px-3 py-2 ${b.status === "accepted" ? "text-emerald-400" : "text-red-400"}`}>
                    {b.status === "accepted" ? "Highest" : "Outbid/Rejected"}
                  </td>
                </tr>
              ))}
              {bids.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-3 py-4 text-center text-slate-500">
                    No bids yet
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
