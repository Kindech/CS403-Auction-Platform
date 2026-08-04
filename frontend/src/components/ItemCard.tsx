import { Link } from "react-router-dom";
import { useEffect, useState } from "react";
import type { Item } from "../types";
import { formatMoney, formatCountdown } from "../lib/format";

const STATUS_STYLE: Record<Item["status"], string> = {
  live: "bg-emerald-600 text-white",
  upcoming: "bg-amber-500 text-black",
  ended: "bg-slate-600 text-slate-200",
};

export function ItemCard({ item }: { item: Item }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const targetMs =
    item.status === "upcoming"
      ? new Date(item.start_time).getTime()
      : new Date(item.end_time).getTime();

  return (
    <Link
      to={`/auctions/${item.id}`}
      className="block rounded-lg border border-slate-800 bg-slate-900 overflow-hidden hover:border-emerald-500 transition-colors"
    >
      <div className="aspect-video bg-slate-800 overflow-hidden">
        {item.image_url && (
          <img src={item.image_url} alt={item.title} className="w-full h-full object-cover" />
        )}
      </div>
      <div className="p-4">
        <div className="flex items-center justify-between mb-2">
          <span className={`text-xs font-semibold px-2 py-0.5 rounded ${STATUS_STYLE[item.status]}`}>
            {item.status.toUpperCase()}
          </span>
          {item.status !== "ended" && (
            <span className="text-xs text-slate-400 font-mono">{formatCountdown(targetMs, now)}</span>
          )}
        </div>
        <h3 className="font-medium truncate">{item.title}</h3>
        <p className="text-sm text-slate-400 mt-1">
          {item.status === "ended"
            ? `Sold for ${formatMoney(item.final_price ?? item.current_price)}`
            : `Current: ${formatMoney(item.current_price)}`}
        </p>
      </div>
    </Link>
  );
}
