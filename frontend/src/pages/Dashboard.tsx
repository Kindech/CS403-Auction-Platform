import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { Item, ItemStatus } from "../types";
import { ItemCard } from "../components/ItemCard";

type Filter = "all" | ItemStatus;

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "ทั้งหมด" },
  { key: "live", label: "กำลังประมูล" },
  { key: "upcoming", label: "เร็วๆ นี้" },
  { key: "ended", label: "สิ้นสุด" },
];

export function Dashboard() {
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await api.get<Item[]>("/items");
        if (!cancelled) setItems(data ?? []);
      } catch {
        if (!cancelled) setError("Could not load auction items");
      }
    }
    load();
    const id = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: items.length, live: 0, upcoming: 0, ended: 0 };
    for (const it of items) c[it.status]++;
    return c;
  }, [items]);

  const order: Record<Item["status"], number> = { live: 0, upcoming: 1, ended: 2 };
  const visible = items
    .filter((it) => filter === "all" || it.status === filter)
    .filter((it) => it.title.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => order[a.status] - order[b.status]);

  return (
    <div className="-mx-6 -mt-8">
      <section className="bg-ink text-cream">
        <div className="max-w-7xl mx-auto px-6 py-12 md:py-16">
          <p className="text-[10px] tracking-[0.2em] text-gold uppercase mb-3">บ้านประมูลออนไลน์</p>
          <h1 className="font-serif-display text-4xl md:text-5xl font-bold leading-tight mb-3">ของสะสม</h1>
          <p className="text-cream/70 max-w-xl">
            ประมูลนาฬิกาวินเทจ งานศิลปะ และของสะสมระดับโลก พร้อมระบบบันทึกประวัติการประมูลที่โปร่งใส
            ตรวจสอบย้อนหลังได้แบบเรียลไทม์
          </p>
        </div>
      </section>

      <div className="max-w-7xl mx-auto px-6 py-8">
        <div className="flex flex-col sm:flex-row gap-3 mb-6">
          <input
            className="flex-1 px-3.5 py-2.5 border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-gold/40 bg-cream text-sm"
            placeholder="ค้นหาสินค้า..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="flex gap-2 flex-wrap">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={`px-3.5 py-1.5 rounded-full text-xs font-semibold transition-colors border ${
                  filter === f.key
                    ? "bg-ink text-cream border-ink"
                    : "bg-white text-ink-muted border-slate-200 hover:border-ink/30"
                }`}
              >
                {f.label} ({counts[f.key]})
              </button>
            ))}
          </div>
        </div>

        {error && <p className="text-red-600">{error}</p>}
        {visible.length === 0 && !error && <p className="text-ink-muted">ไม่พบสินค้าประมูล</p>}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {visible.map((item) => (
            <ItemCard key={item.id} item={item} />
          ))}
        </div>
      </div>
    </div>
  );
}
