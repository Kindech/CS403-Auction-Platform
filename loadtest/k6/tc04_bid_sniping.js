// TC-04 Bid Sniping / High-Concurrency Messaging (report Table 3.1)
// Scenario: 1000 clients connect, then all send a bid "at once" (the
// classic last-second sniping stampede). To make the flood deterministic
// rather than dependent on real-world timing, every client bids the exact
// same amount - the strongest possible collision. Expected result: 100% of
// connections survive the flood and exactly one bid wins.
//
// Every VU is its own user (as 1000 real snipers would be), so "exactly one
// winner" means one of 1000 different people, and each loser hears only about
// their own bid. setup() then waits for the HPA to settle after registering
// them; see registerUsers / waitForBaseline in lib/common.js.
import ws from "k6/ws";
import { check, sleep } from "k6";
import { Counter } from "k6/metrics";
import { login, freshItem, getBids, wsUrlFor, registerUsers, waitForBaseline } from "./lib/common.js";

const VUS = Number(__ENV.VUS || 1000);
const SNIPE_AMOUNT = 110; // starting_price(100) + bid_increment(10)

const connectSuccess = new Counter("connect_success");
const priceUpdates = new Counter("msg_price_update"); // the one winning bid, seen by everyone
const lostBids = new Counter("bid_outcome_rejected_bid_too_low");
const otherMsgs = new Counter("msg_other");

export const options = {
  setupTimeout: "10m",
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
    msg_price_update: [`count>=${Math.floor(VUS * 0.99)}`], // everyone sees the winning price
    checks: ["rate==1"],
    // Not pass/fail criteria: listed so each count prints under THRESHOLDS.
    bid_outcome_rejected_bid_too_low: ["count>=0"],
    msg_other: ["count>=0"],
  },
};

export function setup() {
  const tokens = registerUsers(VUS, "TC04 Sniper");
  waitForBaseline();
  const seller = login("seller@example.com", "password123");
  const item = freshItem(seller.token, {
    title: "TC-04 Bid Sniping Test Item",
    startingPrice: 100,
    bidIncrement: 10,
    durationSec: 300,
  });
  return { itemId: item.id, tokens };
}

export default function (data) {
  const token = data.tokens[(__VU - 1) % data.tokens.length];
  const res = ws.connect(wsUrlFor(data.itemId, token), {}, function (socket) {
    socket.on("open", () => connectSuccess.add(1));
    socket.on("message", (raw) => {
      const evt = JSON.parse(raw);
      if (evt.type === "sync") return;
      if (evt.type === "price_update") priceUpdates.add(1);
      else if (evt.type === "bid_rejected" && evt.reason === "bid_too_low") lostBids.add(1);
      else otherMsgs.add(1);
    });

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
  sleep(2); // let bid-worker's async batch write the rows
  const bids = getBids(data.itemId).filter((b) => b.amount === SNIPE_AMOUNT);
  const accepted = bids.filter((b) => b.status === "accepted");
  const tooLow = bids.filter((b) => b.status === "rejected" && b.reason === "bid_too_low");
  console.log(`bids recorded: ${bids.length}, accepted: ${accepted.length}, rejected bid_too_low: ${tooLow.length}`);

  check(null, {
    "every bid was recorded": () => bids.length === data.tokens.filter((t) => t).length,
    "exactly one winner emerged from the identical-amount stampede": () => accepted.length === 1,
    "every other identical bid was rejected as bid_too_low": () => tooLow.length === bids.length - 1,
  });
}
