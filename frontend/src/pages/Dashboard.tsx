import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Item } from "../types";
import { ItemCard } from "../components/ItemCard";

export function Dashboard() {
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState<string | null>(null);

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

  const order: Record<Item["status"], number> = { live: 0, upcoming: 1, ended: 2 };
  const sorted = [...items].sort((a, b) => order[a.status] - order[b.status]);

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-6">Auctions</h1>
      {error && <p className="text-red-400">{error}</p>}
      {sorted.length === 0 && !error && <p className="text-slate-400">No items listed yet.</p>}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {sorted.map((item) => (
          <ItemCard key={item.id} item={item} />
        ))}
      </div>
    </div>
  );
}
