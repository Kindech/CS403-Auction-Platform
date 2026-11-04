import type { Bid } from "../types";

/** The lowest bid the server will accept right now (in cents, like the server). */
export function minNextBid(price: number, increment: number, hasBids: boolean): number {
  if (!hasBids) return price; // the starting price itself is a valid opening bid
  return (Math.round(price * 100) + Math.round(increment * 100)) / 100;
}

/** At most 2 decimals, because that is what the server accepts and stores. */
export function isValidAmount(value: number): boolean {
  if (!Number.isFinite(value) || value <= 0 || value > 999_999_999_999.99) return false;
  return Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
}

/** The bid currently leading (or that won): the highest accepted one. */
export function leadingBidId(bids: Bid[]): string | null {
  let best: Bid | null = null;
  for (const b of bids) {
    if (b.status === "accepted" && (!best || b.amount > best.amount)) best = b;
  }
  return best?.id ?? null;
}
