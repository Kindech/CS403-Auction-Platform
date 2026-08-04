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
      <p className="text-emerald-400 uppercase tracking-wide text-sm mb-2">Auction ended</p>
      <h1 className="text-3xl font-semibold mb-4">{item.title}</h1>
      {hasWinner ? (
        <>
          <p className="text-slate-300">Winner</p>
          <p className="text-2xl font-bold text-emerald-400 mb-2">{winnerName}</p>
          <p className="text-slate-300">Final price</p>
          <p className="text-3xl font-bold">{formatMoney(finalPrice ?? item.starting_price)}</p>
        </>
      ) : (
        <p className="text-slate-400">No bids were placed - this item did not sell.</p>
      )}

      <h2 className="text-lg font-medium mt-10 mb-3 text-left">Bid history</h2>
      <table className="w-full text-sm text-left border border-slate-800 rounded overflow-hidden">
        <thead className="bg-slate-900 text-slate-400">
          <tr>
            <th className="px-3 py-2">Bidder</th>
            <th className="px-3 py-2">Amount</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Time</th>
          </tr>
        </thead>
        <tbody>
          {bids.map((b) => (
            <tr key={b.id} className="border-t border-slate-800">
              <td className="px-3 py-2">{b.user_name}</td>
              <td className="px-3 py-2">{formatMoney(b.amount)}</td>
              <td className={`px-3 py-2 ${b.status === "accepted" ? "text-emerald-400" : "text-red-400"}`}>
                {b.status}
              </td>
              <td className="px-3 py-2 text-slate-400">{new Date(b.created_at).toLocaleTimeString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
