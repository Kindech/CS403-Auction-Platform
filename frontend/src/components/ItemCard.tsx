import { Link } from "react-router-dom";
import { useEffect, useState } from "react";
import type { Item } from "../types";
import { formatMoney, formatCountdown } from "../lib/format";

const STATUS_BADGE: Record<Item["status"], string> = {
  upcoming: "bg-blue-50 text-blue-700 border-blue-200",
  live: "bg-red-50 text-red-700 border-red-200",
  ended: "bg-slate-100 text-slate-600 border-slate-200",
};

const STATUS_LABEL: Record<Item["status"], string> = {
  upcoming: "เร็วๆ นี้",
  live: "กำลังประมูล",
  ended: "สิ้นสุดแล้ว",
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
      className="block bg-white rounded-xl shadow-card hover:shadow-card-hover transition-all overflow-hidden border border-slate-100 hover:border-gold/40 group"
    >
      <div className="relative aspect-4/3 overflow-hidden bg-paper">
        {item.image_url && (
          <img
            src={item.image_url}
            alt={item.title}
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        )}
        <span
          className={`absolute top-3 left-3 inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold border backdrop-blur-sm ${STATUS_BADGE[item.status]}`}
        >
          {STATUS_LABEL[item.status]}
        </span>
        {item.status === "live" && (
          <span className="absolute top-3 right-3 px-2 py-1 rounded-full bg-ink/80 text-cream text-[10px] backdrop-blur-sm flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
            LIVE
          </span>
        )}
      </div>

      <div className="p-4">
        <h3 className="font-serif-display text-lg font-semibold leading-tight text-ink line-clamp-2 mb-3 min-h-14">
          {item.title}
        </h3>

        <p className="text-[10px] uppercase tracking-wider text-ink-muted">
          {item.status === "ended" ? "ราคาสุดท้าย" : item.status === "upcoming" ? "ราคาเริ่มต้น" : "ราคาปัจจุบัน"}
        </p>
        <p className="font-mono-digits text-xl font-bold text-ink mb-3">
          {formatMoney(item.status === "ended" ? item.final_price ?? item.current_price : item.current_price)}
        </p>

        {item.status === "ended" ? (
          item.winner_name ? (
            <p className="text-xs text-ink-muted">
              ผู้ชนะ: <span className="text-ink font-medium">{item.winner_name}</span>
            </p>
          ) : (
            <p className="text-xs text-ink-muted">ไม่มีผู้เสนอราคา</p>
          )
        ) : (
          <>
            <p className="text-[10px] uppercase tracking-wider text-ink-muted">
              {item.status === "upcoming" ? "เริ่มประมูลใน" : "สิ้นสุดประมูลใน"}
            </p>
            <p className="font-mono-digits font-bold text-sm text-ink">{formatCountdown(targetMs, now)}</p>
          </>
        )}
      </div>
    </Link>
  );
}
