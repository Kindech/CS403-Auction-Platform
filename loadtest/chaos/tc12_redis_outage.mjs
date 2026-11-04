// TC-12 Redis Outage (added - TC-10 and TC-11 cover Kafka and Postgres, but
// bid-worker also needs Redis both to decide a bid and to announce the result).
//
// Redis is stopped for DOWN_MS while a bidder is connected. Checks:
//   - every bid during the outage is answered "service_unavailable" quickly,
//     instead of the bidder hearing nothing
//   - none of those bids is accepted after Redis returns
//   - bidding recovers by itself, and viewers get live prices again (api-server
//     re-subscribes to the event channel with no restart)
// Redis is always started again at the end, pass or fail.
//
// Usage: node chaos/tc12_redis_outage.mjs              (docker compose)
//        TARGET=k8s node chaos/tc12_redis_outage.mjs   (Kubernetes, k8s/)
// Env:   BASE_URL (default http://localhost:8080), VIEWERS (default 20),
//        DOWN_MS (default 10000), STOP_CMD / START_CMD
import { register, createLiveItem, waitFor, sleep, Viewer, check, allPassed, cleanup,
  redisCli, stopService, startService, bidAndWait, dbBids } from "./lib.mjs";

const BASE = process.env.BASE_URL || "http://localhost:8080";
const VIEWERS = Number(process.env.VIEWERS || 20);
const DOWN_MS = Number(process.env.DOWN_MS || 10000);
const INCREMENT = 10;

const redisUp = () => { try { return redisCli("PING").trim() === "PONG"; } catch { return false; } };

const ctx = { conns: [] };
let stopped = false;
try {
  console.log("==> Creating throwaway users and a live item");
  const seller = await register(BASE, "tc12-seller", "Tc12 Seller");
  const bidder = await register(BASE, "tc12-bidder", "Tc12 Bidder");
  ctx.userIds = [seller.id, bidder.id];
  const item = await createLiveItem(BASE, seller.token, "TC-12 Redis Outage Test Item", { increment: INCREMENT });
  ctx.itemId = item.id;

  console.log(`==> Connecting ${VIEWERS} viewers + 1 bidder`);
  const viewers = Array.from({ length: VIEWERS }, (_, i) => new Viewer(`anon#${i}`, BASE, item.id, { reconnect: true }));
  const bidderWs = new Viewer("bidder", BASE, item.id, { token: bidder.token, reconnect: true });
  ctx.conns = [...viewers, bidderWs];
  await Promise.all(ctx.conns.map((v) => v.open()));
  await waitFor(() => ctx.conns.every((v) => v.got("sync")), 5000, "every viewer's sync");

  let amount = 100;
  const nextBid = async (phase) => {
    amount += INCREMENT;
    const r = { ...(await bidAndWait(bidderWs, amount, 8000)), phase };
    console.log(`    [${phase.padEnd(6)}] bid ${r.amount} -> ${r.outcome}${r.reason ? ` (${r.reason})` : ""} in ${r.at - r.sentAt}ms`);
    return r;
  };

  const before = await nextBid("before");
  check(before.outcome === "accepted", "bid accepted before the outage");

  console.log(`==> Stopping Redis for ${DOWN_MS / 1000}s`);
  stopService("redis");
  stopped = true;
  await sleep(3000); // api-server's health check needs up to about 2.5s to notice
  const down = [];
  const downUntil = Date.now() + DOWN_MS;
  while (Date.now() < downUntil) { down.push(await nextBid("down")); await sleep(500); }
  check(down.length >= 3 && down.every((r) => r.outcome === "rejected" && r.reason === "service_unavailable"),
    `${down.filter((r) => r.reason === "service_unavailable").length}/${down.length} bids during the outage were answered "service_unavailable"`);
  const slowest = Math.max(...down.map((r) => r.at - r.sentAt));
  check(slowest < 2000, `the bidder was told quickly (slowest answer ${slowest}ms, limit 2000ms)`);

  console.log("==> Starting Redis again (nothing else is restarted)");
  startService("redis");
  stopped = false;
  await waitFor(redisUp, 120000, "Redis to answer");

  // The first bids may still be answered service_unavailable while the
  // connection pool notices Redis is back.
  let after;
  const backAt = Date.now();
  const refused = new Set(down.map((r) => r.amount));
  await waitFor(async () => {
    after = await nextBid("after");
    if (after.outcome !== "accepted") { refused.add(after.amount); await sleep(500); }
    return after.outcome === "accepted";
  }, 60000, "bidding to recover").catch(() => {});
  check(after?.outcome === "accepted", `bidding recovered on its own ${((Date.now() - backAt) / 1000).toFixed(1)}s after Redis answered`);

  const final = await nextBid("after");
  check(final.outcome === "accepted", "the next bid was accepted too");
  ctx.expectedBids = 3;

  await waitFor(() => viewers.every((v) => v.got("price_update", (e) => e.price === final.amount)), 15000, "viewers to see the new price").catch(() => {});
  const saw = viewers.filter((v) => v.got("price_update", (e) => e.price === final.amount)).length;
  check(saw === VIEWERS, `${saw}/${VIEWERS} viewers got live prices again after the outage`);

  let db;
  await waitFor(() => { db = dbBids(item.id); return db.accepted.includes(final.amount); }, 15000, "bid rows").catch(() => {});
  const wrongly = db.accepted.filter((a) => refused.has(a));
  check(wrongly.length === 0, `no bid answered "service_unavailable" was accepted later (accepted: ${db.accepted.join(", ")})`);
  const redisPrice = Number(redisCli("HGET", `item:${item.id}:state`, "price").trim());
  check(redisPrice === final.amount, `Redis current price ${redisPrice} = last accepted bid ${final.amount}`);
} catch (e) {
  check(false, `test aborted: ${e.message}`);
} finally {
  ctx.conns.forEach((v) => v.close());
  if (stopped) {
    try { startService("redis"); } catch (e) { console.log(`    (start redis: ${e.message})`); }
    await waitFor(redisUp, 120000, "Redis").catch(() => {});
  }
  console.log("==> Cleaning up test data");
  await cleanup(ctx).catch((e) => console.log(`    cleanup failed: ${e.message}`));
}

console.log(allPassed() ? "PASS: TC-12 a Redis outage cost bidders a clear \"try again\", never silence" : "FAIL: TC-12");
process.exit(allPassed() ? 0 : 1);
