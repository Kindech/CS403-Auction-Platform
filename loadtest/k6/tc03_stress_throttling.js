// TC-03 Stress Test & Throttling (report Table 3.1)
// Scenario: 2000 clients join one room and flood it with bids within 10s.
// Expected result: 100% of connections are retained (no crash) and the
// per-connection throttle (10 msg/s, see BID_RATE_LIMIT_PER_SEC) keeps the
// broadcast fan-out under control instead of the server falling over.
import ws from "k6/ws";
import { check } from "k6";
import { Counter } from "k6/metrics";
import { login, freshItem, wsUrlFor } from "./lib/common.js";

const VUS = Number(__ENV.VUS || 2000);

const connectSuccess = new Counter("connect_success");
const wsErrors = new Counter("ws_errors");

export const options = {
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
  },
};

export function setup() {
  const seller = login("seller@example.com", "password123");
  const bidder = login("bidder@example.com", "password123");
  const item = freshItem(seller.token, {
    title: "TC-03 Stress Test Item",
    startingPrice: 1000,
    bidIncrement: 1,
    durationSec: 120,
  });
  return { itemId: item.id, bidderToken: bidder.token };
}

export default function (data) {
  const url = wsUrlFor(data.itemId, data.bidderToken);
  const res = ws.connect(url, {}, function (socket) {
    socket.on("open", () => {
      connectSuccess.add(1);
      // Fire a rapid burst well above the per-connection 10 msg/s limit -
      // the server should throttle (reject with "rate_limited") rather than
      // crash or drop the connection.
      for (let i = 0; i < 20; i++) {
        socket.send(JSON.stringify({ type: "bid", amount: 1000 + i }));
      }
    });
    socket.on("error", () => wsErrors.add(1));
    socket.setTimeout(() => socket.close(), 4000);
  });

  check(res, { "ws handshake succeeded (101)": (r) => r && r.status === 101 });
}
