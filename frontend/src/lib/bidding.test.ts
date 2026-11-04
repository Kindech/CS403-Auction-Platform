import { describe, expect, it } from "vitest";
import { isValidAmount, leadingBidId, minNextBid } from "./bidding";
import type { Bid } from "../types";

const bid = (id: string, amount: number, status: Bid["status"] = "accepted"): Bid => ({
  id,
  item_id: "item",
  amount,
  status,
  created_at: "2026-01-01T00:00:00Z",
});

describe("minNextBid", () => {
  it("allows the starting price as the opening bid", () => {
    expect(minNextBid(100, 10, false)).toBe(100);
  });
  it("requires price + increment once someone has bid", () => {
    expect(minNextBid(100, 10, true)).toBe(110);
  });
  it("isn't thrown off by float rounding", () => {
    expect(minNextBid(0.1, 0.2, true)).toBe(0.3);
  });
});

describe("isValidAmount", () => {
  it.each([[110], [0.01], [110.12], [999_999_999_999.99]])("accepts %d", (v) => {
    expect(isValidAmount(v)).toBe(true);
  });
  it.each([[0], [-5], [110.126], [1e13], [NaN], [Infinity]])("rejects %d", (v) => {
    expect(isValidAmount(v)).toBe(false);
  });
});

describe("leadingBidId", () => {
  it("is the highest accepted bid, wherever it is in the list", () => {
    expect(leadingBidId([bid("a", 110), bid("c", 130), bid("b", 120)])).toBe("c");
  });
  it("ignores rejected bids", () => {
    expect(leadingBidId([bid("high", 500, "rejected"), bid("ok", 110)])).toBe("ok");
  });
  it("is null when nothing was accepted", () => {
    expect(leadingBidId([bid("x", 100, "rejected")])).toBeNull();
    expect(leadingBidId([])).toBeNull();
  });
});
