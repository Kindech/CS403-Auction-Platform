// TC-07 Reconnect Resync (added - required by report section 3.6.3's "no
// page reload, always in sync" claim, which the happy-path diagrams don't
// cover explicitly). A client that disconnects and reconnects mid-auction
// must get a fresh "sync" reflecting whatever happened while it was gone,
// never the stale price it had before dropping.
import ws from "k6/ws";
import { check, sleep } from "k6";
import { login, freshItem, wsUrlFor } from "./lib/common.js";

export const options = {
  vus: 1,
  iterations: 1,
  maxDuration: "30s",
  thresholds: { checks: ["rate==1"] },
};

function connectAndGetSync(itemId, token) {
  let syncPrice = null;
  ws.connect(wsUrlFor(itemId, token), {}, function (socket) {
    socket.on("message", (raw) => {
      const evt = JSON.parse(raw);
      if (evt.type === "sync") {
        syncPrice = evt.price;
        socket.close();
      }
    });
    socket.setTimeout(() => socket.close(), 5000);
  });
  return syncPrice;
}

function placeBidAndWait(itemId, token, amount) {
  ws.connect(wsUrlFor(itemId, token), {}, function (socket) {
    let synced = false;
    socket.on("message", (raw) => {
      const evt = JSON.parse(raw);
      if (evt.type === "sync" && !synced) {
        synced = true;
        socket.send(JSON.stringify({ type: "bid", amount }));
      }
      if (evt.type === "price_update") {
        socket.close();
      }
    });
    socket.setTimeout(() => socket.close(), 5000);
  });
}

export default function () {
  const seller = login("seller@example.com", "password123");
  const bidderA = login("bidder@example.com", "password123");
  const item = freshItem(seller.token, {
    title: "TC-07 Reconnect Resync Test Item",
    startingPrice: 100,
    bidIncrement: 10,
    durationSec: 120,
  });

  // 1. Connect and capture the initial sync (should be the starting price).
  const firstSync = connectAndGetSync(item.id, bidderA.token);
  check(null, { "initial sync reflects starting price": () => firstSync === 100 });

  // 2. Disconnect happens implicitly (socket.close() above). While "away",
  //    someone else raises the price.
  sleep(0.5);
  const racer = login("bidder@example.com", "password123"); // same demo account is fine; identity doesn't matter here
  placeBidAndWait(item.id, racer.token, 150);
  sleep(0.5);

  // 3. Reconnect - must resync to the NEW price, not the stale 100.
  const secondSync = connectAndGetSync(item.id, bidderA.token);
  check(null, { "reconnect sync reflects the price that changed while disconnected": () => secondSync === 150 });
}
