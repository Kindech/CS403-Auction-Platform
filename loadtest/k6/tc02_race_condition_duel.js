// TC-02 Race Condition (The Duel) (report Table 3.1)
// Scenario: 2 distinct clients send the exact same bid amount at (as close
// as k6 can arrange) the same instant. Expected result: the atomic,
// Kafka-ordered decision picks exactly one winner and rejects the other -
// never both accepted, never both rejected.
import ws from "k6/ws";
import { check, sleep } from "k6";
import { login, register, freshItem, getBids, wsUrlFor } from "./lib/common.js";

export const options = {
  scenarios: {
    duel: { executor: "per-vu-iterations", vus: 2, iterations: 1, maxDuration: "15s" },
  },
  thresholds: {
    checks: ["rate==1"],
  },
};

export function setup() {
  const seller = login("seller@example.com", "password123");
  const item = freshItem(seller.token, { title: "TC-02 Duel Test Item", durationSec: 120 });
  const racerA = register("racer-a", "password123", "Racer A");
  const racerB = register("racer-b", "password123", "Racer B");
  return { itemId: item.id, racerA, racerB };
}

export default function (data) {
  const isA = __VU === 1;
  const token = isA ? data.racerA.token : data.racerB.token;
  const contestedAmount = 150; // both racers bid the exact same amount

  const res = ws.connect(wsUrlFor(data.itemId, token), {}, function (socket) {
    socket.on("message", (raw) => {
      const evt = JSON.parse(raw);
      if (evt.type === "sync") {
        // Both VUs schedule their bid the same fixed delay after their own
        // sync so they land as close together as k6's event loop allows.
        socket.setTimeout(() => {
          socket.send(JSON.stringify({ type: "bid", amount: contestedAmount }));
        }, 1500);
      }
    });
    socket.setTimeout(() => socket.close(), 6000);
  });

  check(res, { "ws handshake succeeded (101)": (r) => r && r.status === 101 });
}

export function teardown(data) {
  sleep(1.5); // let bid-worker's async batch flush the audit rows
  const bids = getBids(data.itemId);
  const accepted = bids.filter((b) => b.status === "accepted");
  const rejected = bids.filter((b) => b.status === "rejected");

  check(null, {
    "exactly 2 bid attempts were recorded": () => bids.length === 2,
    "exactly 1 bid was accepted": () => accepted.length === 1,
    "exactly 1 bid was rejected": () => rejected.length === 1,
  });
}
