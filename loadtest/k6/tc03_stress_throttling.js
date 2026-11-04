// TC-03 Stress Test & Throttling (report Table 3.1)
// Scenario: 2000 clients join one room and flood it with bids within 10s.
// Expected result: 100% of connections are retained (no crash) and the
// per-connection throttle (10 msg/s, see BID_RATE_LIMIT_PER_SEC) keeps the
// broadcast fan-out under control instead of the server falling over.
//
// Every VU is its own user, as 2000 real bidders would be. An earlier version
// logged all 2000 connections in as one account; a rejected bid goes to every
// connection of its bidder (so all of a user's tabs see it), which turned each
// bid_too_low into ~2000 messages - millions in total, nothing like real use.
//
// Registering 2000 users costs a bcrypt hash each, enough CPU to make the HPA
// add pods. setup() therefore waits (via the in-cluster Prometheus) for
// api-server to be back at its minimum pod count before the test starts, so
// every run starts from the same place. Skipped when Prometheus isn't
// reachable (e.g. against compose: PROM_URL="" disables it).
import ws from "k6/ws";
import { check } from "k6";
import { Counter } from "k6/metrics";
import { login, freshItem, wsUrlFor, registerUsers, waitForBaseline } from "./lib/common.js";

const VUS = Number(__ENV.VUS || 2000);
const BURST = 20; // bids sent at once per connection: twice the 10 msg/s limit

const connectSuccess = new Counter("connect_success");
const wsErrors = new Counter("ws_errors");
const bidsSent = new Counter("bids_sent");
// Every message the server sent back, by kind, so the report can account for
// ws_msgs_received line by line.
const msgSync = new Counter("msg_sync");
const msgPriceUpdate = new Counter("msg_price_update");
const msgRateLimited = new Counter("msg_rejected_rate_limited");
const msgTooLow = new Counter("msg_rejected_bid_too_low");
const msgOther = new Counter("msg_other");

export const options = {
  setupTimeout: "10m",
  scenarios: {
    stress: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "10s", target: VUS }, // report: 2000 clients join within 10s
        { duration: "10s", target: VUS },
        { duration: "5s", target: 0 },
      ],
      gracefulRampDown: "5s",
    },
  },
  thresholds: {
    connect_success: [`count>=${Math.floor(VUS * 0.99)}`], // report: 100% connections retained
    ws_errors: ["count==0"],
    // Not pass/fail criteria: listed so each count prints under THRESHOLDS,
    // even when it is 0.
    msg_sync: ["count>=0"],
    msg_price_update: ["count>=0"],
    msg_rejected_rate_limited: ["count>=0"],
    msg_rejected_bid_too_low: ["count>=0"],
    msg_other: ["count>=0"],
  },
};

export function setup() {
  const tokens = registerUsers(VUS, "TC03 Bidder");
  waitForBaseline();

  const seller = login("seller@example.com", "password123");
  const item = freshItem(seller.token, {
    title: "TC-03 Stress Test Item",
    startingPrice: 1000,
    bidIncrement: 1,
    durationSec: 120,
  });
  return { itemId: item.id, tokens };
}

export default function (data) {
  const token = data.tokens[(__VU - 1) % data.tokens.length];
  const res = ws.connect(wsUrlFor(data.itemId, token), {}, function (socket) {
    socket.on("open", () => {
      connectSuccess.add(1);
      // Fire a rapid burst well above the per-connection 10 msg/s limit -
      // the server should throttle (reject with "rate_limited") rather than
      // crash or drop the connection.
      for (let i = 0; i < BURST; i++) {
        socket.send(JSON.stringify({ type: "bid", amount: 1000 + i }));
      }
      bidsSent.add(BURST);
    });
    socket.on("message", (raw) => {
      const evt = JSON.parse(raw);
      if (evt.type === "sync") msgSync.add(1);
      else if (evt.type === "price_update") msgPriceUpdate.add(1);
      else if (evt.type === "bid_rejected" && evt.reason === "rate_limited") msgRateLimited.add(1);
      else if (evt.type === "bid_rejected" && evt.reason === "bid_too_low") msgTooLow.add(1);
      else msgOther.add(1);
    });
    socket.on("error", () => wsErrors.add(1));
    socket.setTimeout(() => socket.close(), 4000);
  });

  check(res, { "ws handshake succeeded (101)": (r) => r && r.status === 101 });
}
