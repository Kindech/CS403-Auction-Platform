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
      .catch(() => setError("Could not load your bid history"));
  }, []);

  return (
    <div className="max-w-3xl mx-auto">
      <h1 className="text-2xl font-semibold mb-6">My bid history</h1>
      {error && <p className="text-red-400">{error}</p>}
      <table className="w-full text-sm text-left border border-slate-800 rounded overflow-hidden">
        <thead className="bg-slate-900 text-slate-400">
          <tr>
            <th className="px-3 py-2">Item</th>
            <th className="px-3 py-2">Amount</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Time</th>
          </tr>
        </thead>
        <tbody>
          {bids.map((b) => (
            <tr key={b.id} className="border-t border-slate-800">
              <td className="px-3 py-2">
                <Link className="text-emerald-400 hover:underline" to={`/auctions/${b.item_id}`}>
                  {b.item_title}
                </Link>
              </td>
              <td className="px-3 py-2">{formatMoney(b.amount)}</td>
              <td className={`px-3 py-2 ${b.status === "accepted" ? "text-emerald-400" : "text-red-400"}`}>
                {b.status}
                {b.reason ? ` (${b.reason})` : ""}
              </td>
              <td className="px-3 py-2 text-slate-400">{new Date(b.created_at).toLocaleString()}</td>
            </tr>
          ))}
          {bids.length === 0 && (
            <tr>
              <td colSpan={4} className="px-3 py-4 text-center text-slate-500">
                You haven't placed any bids yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
