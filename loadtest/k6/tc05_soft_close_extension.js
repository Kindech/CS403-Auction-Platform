// TC-05 Soft-Close / Anti-Sniping Extension (added - not in the report's
// TC table, but directly required by report section 3.1.1 step 4: a bid
// arriving inside the anti-snipe window must push end_time back, while an
// early bid must not. This is a correctness test, not a load test: 1 VU,
// real wall-clock waits.
//
// Requires the stack's ANTI_SNIPE_WINDOW/ANTI_SNIPE_EXTENSION (default 60s
// each - see docker-compose.yml). Run with: k6 run tc05_soft_close_extension.js
import ws from "k6/ws";
import { check, sleep } from "k6";
import { login, freshItem, getItem, wsUrlFor } from "./lib/common.js";

const ANTI_SNIPE_WINDOW_SEC = Number(__ENV.ANTI_SNIPE_WINDOW_SEC || 60);
const ITEM_DURATION_SEC = ANTI_SNIPE_WINDOW_SEC + 30; // room to bid both outside and inside the window

export const options = {
  vus: 1,
  iterations: 1,
  // real-time wait for the anti-snipe boundary, so this needs a generous cap
  maxDuration: `${ITEM_DURATION_SEC + 30}s`,
  thresholds: { checks: ["rate==1"] },
};

function bidOnce(itemId, token, amount) {
  let outcome = "no_response";
  ws.connect(wsUrlFor(itemId, token), {}, function (socket) {
    let synced = false;
    socket.on("message", (raw) => {
      const evt = JSON.parse(raw);
      if (evt.type === "sync" && !synced) {
        synced = true;
        socket.send(JSON.stringify({ type: "bid", amount }));
      }
      if (evt.type === "price_update") {
        outcome = "accepted";
        socket.close();
      }
      if (evt.type === "bid_rejected") {
        outcome = `rejected:${evt.reason}`;
        socket.close();
      }
    });
    socket.setTimeout(() => socket.close(), 5000);
  });
  console.log(`bidOnce(amount=${amount}) -> ${outcome}`);
  return outcome;
}

export default function () {
  const seller = login("seller@example.com", "password123");
  const bidder = login("bidder@example.com", "password123");
  const item = freshItem(seller.token, {
    title: "TC-05 Soft-Close Test Item",
    startingPrice: 100,
    bidIncrement: 10,
    durationSec: ITEM_DURATION_SEC,
  });
  const originalEndTime = new Date(item.end_time).getTime();

  // Bid #1: fires immediately, far outside the anti-snipe window
  // (ITEM_DURATION_SEC - a few seconds remaining > ANTI_SNIPE_WINDOW_SEC).
  const earlyOutcome = bidOnce(item.id, bidder.token, 110);
  sleep(2);
  const afterEarlyBid = getItem(item.id);
  const earlyEndTime = new Date(afterEarlyBid.end_time).getTime();
  console.log(`early bid outcome=${earlyOutcome} originalEndTime=${originalEndTime} earlyEndTime=${earlyEndTime} now=${Date.now()}`);

  check(null, {
    "early bid was accepted": () => earlyOutcome === "accepted",
    "early bid does NOT extend end_time": () => earlyEndTime === originalEndTime,
  });

  // Wait until only ANTI_SNIPE_WINDOW_SEC - 5s remains, i.e. inside the window.
  const secondsUntilInsideWindow = ITEM_DURATION_SEC - (ANTI_SNIPE_WINDOW_SEC - 5) - 2;
  sleep(Math.max(secondsUntilInsideWindow, 0));

  const lateOutcome = bidOnce(item.id, bidder.token, 130);
  sleep(2);
  const afterLateBid = getItem(item.id);
  const lateEndTime = new Date(afterLateBid.end_time).getTime();
  console.log(`late bid outcome=${lateOutcome} earlyEndTime=${earlyEndTime} lateEndTime=${lateEndTime} now=${Date.now()} msRemainingAtLateBid=${earlyEndTime - Date.now()}`);

  check(null, {
    "late bid was accepted": () => lateOutcome === "accepted",
    "late bid (inside anti-snipe window) DOES extend end_time": () => lateEndTime > earlyEndTime,
  });
}
