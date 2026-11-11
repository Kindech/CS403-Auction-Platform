import type { Bid } from "../types";

export interface BidStats {
  bidCount: number; // accepted bids
  bidderCount: number; // distinct people who placed an accepted bid
  highest: number | null;
  increasePct: number | null; // highest vs starting price; null before the first bid
}

// Who placed a bid. bidder_key is stable per person within one item; the
// masked name is only a fallback (two different people can both be "B***r").
export function bidderOf(b: Bid): string {
  return b.bidder_key || b.user_id || b.user_name || b.id;
}

export function computeBidStats(bids: Bid[], startingPrice: number): BidStats {
  const accepted = bids.filter((b) => b.status === "accepted");
  const bidders = new Set(accepted.map(bidderOf));
  const highest = accepted.length ? Math.max(...accepted.map((b) => b.amount)) : null;
  const increasePct =
    highest !== null && startingPrice > 0 ? ((highest - startingPrice) / startingPrice) * 100 : null;
  return { bidCount: accepted.length, bidderCount: bidders.size, highest, increasePct };
}

export type BidSort = "amount_desc" | "amount_asc" | "time_desc" | "time_asc";

// Accepted bids for the history table: filtered by bidder name, sorted.
export function filterAndSortBids(bids: Bid[], query: string, sort: BidSort): Bid[] {
  const q = query.trim().toLowerCase();
  const rows = bids.filter((b) => b.status === "accepted" && (!q || (b.user_name ?? "").toLowerCase().includes(q)));
  const time = (b: Bid) => new Date(b.created_at).getTime();
  const cmp: Record<BidSort, (a: Bid, b: Bid) => number> = {
    amount_desc: (a, b) => b.amount - a.amount || time(b) - time(a),
    amount_asc: (a, b) => a.amount - b.amount || time(a) - time(b),
    time_desc: (a, b) => time(b) - time(a),
    time_asc: (a, b) => time(a) - time(b),
  };
  return rows.sort(cmp[sort]);
}

export function formatPct(pct: number | null): string {
  if (pct === null) return "–";
  return `${pct >= 0 ? "+" : ""}${pct.toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
}
