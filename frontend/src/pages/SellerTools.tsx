import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api";
import type { Item } from "../types";
import { ItemCard } from "../components/ItemCard";

function toLocalInputValue(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

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
      setError("Could not load your items");
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
      setError(err instanceof ApiError ? err.message : "Could not create item");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-5xl mx-auto">
      <h1 className="text-2xl font-semibold mb-6">Seller tools</h1>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <form onSubmit={onSubmit} className="flex flex-col gap-3 rounded-lg border border-slate-800 bg-slate-900 p-6">
          <h2 className="text-lg font-medium mb-2">List a new item</h2>
          <input
            className="rounded bg-slate-800 border border-slate-700 px-3 py-2"
            placeholder="Title"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            required
          />
          <textarea
            className="rounded bg-slate-800 border border-slate-700 px-3 py-2"
            placeholder="Description"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
          <input
            className="rounded bg-slate-800 border border-slate-700 px-3 py-2"
            placeholder="Image URL"
            value={form.image_url}
            onChange={(e) => setForm({ ...form, image_url: e.target.value })}
          />
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm text-slate-400">
              Starting bid
              <input
                type="number"
                className="mt-1 w-full rounded bg-slate-800 border border-slate-700 px-3 py-2"
                value={form.starting_price}
                min={1}
                onChange={(e) => setForm({ ...form, starting_price: Number(e.target.value) })}
                required
              />
            </label>
            <label className="text-sm text-slate-400">
              Bid increment
              <input
                type="number"
                className="mt-1 w-full rounded bg-slate-800 border border-slate-700 px-3 py-2"
                value={form.bid_increment}
                min={1}
                onChange={(e) => setForm({ ...form, bid_increment: Number(e.target.value) })}
                required
              />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm text-slate-400">
              Start time
              <input
                type="datetime-local"
                className="mt-1 w-full rounded bg-slate-800 border border-slate-700 px-3 py-2"
                value={form.start_time}
                onChange={(e) => setForm({ ...form, start_time: e.target.value })}
                required
              />
            </label>
            <label className="text-sm text-slate-400">
              End time
              <input
                type="datetime-local"
                className="mt-1 w-full rounded bg-slate-800 border border-slate-700 px-3 py-2"
                value={form.end_time}
                onChange={(e) => setForm({ ...form, end_time: e.target.value })}
                required
              />
            </label>
          </div>
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <button
            disabled={busy}
            className="rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 px-3 py-2 font-medium mt-2"
          >
            {busy ? "Listing..." : "List item"}
          </button>
        </form>

        <div>
          <h2 className="text-lg font-medium mb-3">Your items</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {items.map((item) => (
              <ItemCard key={item.id} item={item} />
            ))}
            {items.length === 0 && <p className="text-slate-400">You haven't listed anything yet.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
