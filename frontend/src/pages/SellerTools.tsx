import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api";
import type { Item } from "../types";
import { ItemCard } from "../components/ItemCard";

function toLocalInputValue(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const inputCls =
  "mt-1 w-full rounded-md bg-cream border border-slate-200 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold/40";

export function SellerTools() {
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const now = new Date();
  const inFiveMin = new Date(now.getTime() + 5 * 60 * 1000);
  const inTwentyMin = new Date(now.getTime() + 20 * 60 * 1000);

  const [form, setForm] = useState({
    title: "",
    description: "",
    image_url: "",
    starting_price: 100,
    bid_increment: 10,
    start_time: toLocalInputValue(inFiveMin),
    end_time: toLocalInputValue(inTwentyMin),
  });

  async function loadItems() {
    try {
      setItems((await api.get<Item[]>("/items/mine")) ?? []);
    } catch {
      setError("ไม่สามารถโหลดรายการสินค้าของคุณได้");
    }
  }

  useEffect(() => {
    loadItems();
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.post("/items", {
        ...form,
        starting_price: Number(form.starting_price),
        bid_increment: Number(form.bid_increment),
        start_time: new Date(form.start_time).toISOString(),
        end_time: new Date(form.end_time).toISOString(),
      });
      setForm((f) => ({ ...f, title: "", description: "", image_url: "" }));
      await loadItems();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "ไม่สามารถลงรายการสินค้าได้");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="text-[10px] tracking-[0.2em] text-gold-dark uppercase mb-1">สำหรับผู้ขาย</p>
      <h1 className="font-serif-display text-2xl font-bold text-ink mb-6">เครื่องมือจัดการสินค้า</h1>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <form
          onSubmit={onSubmit}
          className="flex flex-col gap-3 rounded-xl border border-slate-100 bg-white shadow-card p-6"
        >
          <h2 className="font-serif-display text-lg font-semibold text-ink mb-1">ลงรายการสินค้าใหม่</h2>
          <input
            className={inputCls}
            placeholder="ชื่อสินค้า"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            required
          />
          <textarea
            className={inputCls}
            placeholder="รายละเอียดสินค้า"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
          <input
            className={inputCls}
            placeholder="URL รูปภาพ"
            value={form.image_url}
            onChange={(e) => setForm({ ...form, image_url: e.target.value })}
          />
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs uppercase tracking-wider text-ink-muted">
              ราคาเริ่มต้น
              <input
                type="number"
                className={inputCls}
                value={form.starting_price}
                min={1}
                onChange={(e) => setForm({ ...form, starting_price: Number(e.target.value) })}
                required
              />
            </label>
            <label className="text-xs uppercase tracking-wider text-ink-muted">
              หน่วยเพิ่มราคาขั้นต่ำ
              <input
                type="number"
                className={inputCls}
                value={form.bid_increment}
                min={1}
                onChange={(e) => setForm({ ...form, bid_increment: Number(e.target.value) })}
                required
              />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs uppercase tracking-wider text-ink-muted">
              เวลาเริ่มประมูล
              <input
                type="datetime-local"
                className={inputCls}
                value={form.start_time}
                onChange={(e) => setForm({ ...form, start_time: e.target.value })}
                required
              />
            </label>
            <label className="text-xs uppercase tracking-wider text-ink-muted">
              เวลาสิ้นสุดประมูล
              <input
                type="datetime-local"
                className={inputCls}
                value={form.end_time}
                onChange={(e) => setForm({ ...form, end_time: e.target.value })}
                required
              />
            </label>
          </div>
          {error && <p className="text-red-600 text-sm">{error}</p>}
          <button
            disabled={busy}
            className="rounded-full bg-gold text-ink hover:bg-gold-dark disabled:opacity-50 px-4 py-2.5 font-semibold text-sm mt-2 transition-colors"
          >
            {busy ? "กำลังลงรายการ..." : "ลงประมูลสินค้า"}
          </button>
        </form>

        <div>
          <h2 className="font-serif-display text-lg font-semibold text-ink mb-3">สินค้าของฉัน</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {items.map((item) => (
              <ItemCard key={item.id} item={item} />
            ))}
            {items.length === 0 && <p className="text-ink-muted">คุณยังไม่ได้ลงรายการสินค้าใดๆ</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
