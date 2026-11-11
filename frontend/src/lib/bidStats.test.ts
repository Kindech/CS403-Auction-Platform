import { describe, expect, it } from "vitest";
import type { Bid } from "../types";
import { computeBidStats, filterAndSortBids, formatPct } from "./bidStats";

const bid = (id: string, key: string, name: string, amount: number, t: number, status: Bid["status"] = "accepted"): Bid => ({
  id,
  item_id: "i",
  bidder_key: key,
  user_name: name,
  amount,
  status,
  created_at: new Date(t * 1000).toISOString(),
});

const bids = [
  bid("1", "k1", "B***r", 110, 1),
  bid("2", "k2", "B***r", 120, 2), // a different person with the same masked name
  bid("3", "k1", "B***r", 150, 3),
  bid("4", "k3", "S***a", 140, 4, "rejected"),
];

describe("computeBidStats", () => {
  it("counts accepted bids and distinct bidders by bidder_key, not masked name", () => {
    expect(computeBidStats(bids, 100)).toEqual({ bidCount: 3, bidderCount: 2, highest: 150, increasePct: 50 });
  });
  it("has no highest or increase before the first bid", () => {
    expect(computeBidStats([], 100)).toEqual({ bidCount: 0, bidderCount: 0, highest: null, increasePct: null });
  });
});

describe("filterAndSortBids", () => {
  it("drops rejected bids and sorts by amount, highest first", () => {
    expect(filterAndSortBids(bids, "", "amount_desc").map((b) => b.id)).toEqual(["3", "2", "1"]);
  });
  it("sorts by time", () => {
    expect(filterAndSortBids(bids, "", "time_asc").map((b) => b.id)).toEqual(["1", "2", "3"]);
  });
  it("searches the shown name, case-insensitively", () => {
    expect(filterAndSortBids(bids, "s***", "amount_desc")).toEqual([]);
    expect(filterAndSortBids(bids, "b*", "amount_desc")).toHaveLength(3);
  });
});

it("formats the increase", () => {
  expect(formatPct(50)).toBe("+50%");
  expect(formatPct(12.345)).toBe("+12.3%");
  expect(formatPct(null)).toBe("–");
});
