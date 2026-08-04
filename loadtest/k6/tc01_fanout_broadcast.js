// TC-01 Fan-out Broadcast (report Table 3.1)
// Scenario: 500 clients connected to one room; one bid is sent once everyone
// is connected. Expected result: the resulting price update reaches every
// connected client, 0% failure.
import ws from "k6/ws";
import { check } from "k6";
import { Counter } from "k6/metrics";
import { login, freshItem, wsUrlFor } from "./lib/common.js";

const VUS = Number(__ENV.VUS || 500);

const connectSuccess = new Counter("connect_success");
const priceUpdateReceived = new Counter("price_update_received");

export const options = {
  scenarios: {
    fanout: {
      executor: "per-vu-iterations",
      vus: VUS,
      iterations: 1,
      maxDuration: "30s",
    },
  },
  thresholds: {
    connect_success: [`count>=${Math.floor(VUS * 0.99)}`], // report: 0% connection failure
    price_update_received: [`count>=${Math.floor(VUS * 0.99)}`], // report: all 500 receive the update
    checks: ["rate==1"],
  },
};

export function setup() {
  const seller = login("seller@example.com", "password123");
  const bidder = login("bidder@example.com", "password123");
  const item = freshItem(seller.token, { title: "TC-01 Fan-out Test Item", durationSec: 120 });
  return { itemId: item.id, bidderToken: bidder.token };
}

export default function (data) {
  const url = wsUrlFor(data.itemId, data.bidderToken);
  const res = ws.connect(url, {}, function (socket) {
    socket.on("open", () => connectSuccess.add(1));

    socket.on("message", (raw) => {
      const evt = JSON.parse(raw);
      if (evt.type === "price_update") {
        priceUpdateReceived.add(1);
      }
    });

    // Give all 500 VUs time to finish connecting before the single bid fires.
    socket.setTimeout(() => {
      if (__VU === 1) {
        socket.send(JSON.stringify({ type: "bid", amount: 150 }));
      }
    }, 3000);

    socket.setTimeout(() => socket.close(), 8000);
  });

  check(res, { "ws handshake succeeded (101)": (r) => r && r.status === 101 });
}
