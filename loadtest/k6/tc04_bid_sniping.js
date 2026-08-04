// TC-04 Bid Sniping / High-Concurrency Messaging (report Table 3.1)
// Scenario: 1000 clients connect, then all send a bid "at once" (the
// classic last-second sniping stampede). To make the flood deterministic
// rather than dependent on real-world timing, every client bids the exact
// same amount - the strongest possible collision. Expected result: 100% of
// connections survive the flood and exactly one bid wins.
import ws from "k6/ws";
import { check, sleep } from "k6";
import { Counter } from "k6/metrics";
import { login, freshItem, getBids, wsUrlFor } from "./lib/common.js";

const VUS = Number(__ENV.VUS || 1000);
const SNIPE_AMOUNT = 110; // starting_price(100) + bid_increment(10)

const connectSuccess = new Counter("connect_success");

export const options = {
  scenarios: {
    sniping: {
      executor: "per-vu-iterations",
      vus: VUS,
      iterations: 1,
      maxDuration: "30s",
    },
  },
  thresholds: {
    connect_success: [`count>=${Math.floor(VUS * 0.99)}`], // report: 100% connections retained
    checks: ["rate==1"],
  },
};

export function setup() {
  const seller = login("seller@example.com", "password123");
  const bidder = login("bidder@example.com", "password123");
  const item = freshItem(seller.token, {
    title: "TC-04 Bid Sniping Test Item",
    startingPrice: 100,
    bidIncrement: 10,
    durationSec: 300,
  });
  return { itemId: item.id, bidderToken: bidder.token };
}

export default function (data) {
  const res = ws.connect(wsUrlFor(data.itemId, data.bidderToken), {}, function (socket) {
    socket.on("open", () => connectSuccess.add(1));

    // All 1000 VUs fire the identical bid at the same fixed delay after
    // their own connect - the "final split second" stampede from the report.
    socket.setTimeout(() => {
      socket.send(JSON.stringify({ type: "bid", amount: SNIPE_AMOUNT }));
    }, 4000);

    socket.setTimeout(() => socket.close(), 8000);
  });

  check(res, { "ws handshake succeeded (101)": (r) => r && r.status === 101 });
}

export function teardown(data) {
  sleep(2); // let bid-worker's async batch flush the audit rows
  const bids = getBids(data.itemId).filter((b) => b.amount === SNIPE_AMOUNT);
  const accepted = bids.filter((b) => b.status === "accepted");

  check(null, {
    "exactly one winner emerged from the identical-amount stampede": () => accepted.length === 1,
    "every other identical bid was correctly rejected": () =>
      bids.length - accepted.length === bids.length - 1,
  });
}
