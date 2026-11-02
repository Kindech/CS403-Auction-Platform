// TC-10 Kafka Restart (added - the broker is the one hop every bid must
// cross, report section 2.6.4 "at-least-once processing via offset commit").
//
// A bidder keeps bidding (one bid at a time, waiting for each outcome like a
// user would) while Kafka is stopped for DOWN_MS and started again. Checks:
//   - every bid gets an answer: accepted, or rejected with a reason - a bid
//     sent while Kafka is down must come back as "service_unavailable",
//     never vanish without a reply
//   - "service_unavailable" means it: no such bid is accepted later, when
//     Kafka is back (the broker refuses bids older than models.BidExpiry)
//   - bidding works again on its own after Kafka returns (api-server's
//     producer and bid-worker's consumer reconnect; nothing is restarted)
//   - Postgres ends up with exactly the bids the bidder saw accepted, once
//     each, and Redis holds the last of them
//   - every viewer saw every accepted price, in order
// Kafka is always started again at the end, pass or fail.
//
// Usage: node chaos/tc10_kafka_restart.mjs              (docker compose)
//        TARGET=k8s node chaos/tc10_kafka_restart.mjs   (Kubernetes, k8s/)
// Env:   BASE_URL (default http://localhost:8080), VIEWERS (default 20),
//        DOWN_MS (default 10000), STOP_CMD / START_CMD (override how Kafka
//        is stopped/started)
import { register, createLiveItem, waitFor, sleep, Viewer, check, allPassed, percentile, cleanup,
  redisCli, stopService, startService, bidAndWait, dbBids } from "./lib.mjs";

const BASE = process.env.BASE_URL || "http://localhost:8080";
const VIEWERS = Number(process.env.VIEWERS || 20);
const DOWN_MS = Number(process.env.DOWN_MS || 10000);
const INCREMENT = 10;

const ctx = { conns: [] };
let stopped = false;
try {
  console.log("==> Creating throwaway users and a live item");
  const seller = await register(BASE, "tc10-seller", "Tc10 Seller");
  const bidder = await register(BASE, "tc10-bidder", "Tc10 Bidder");
  ctx.userIds = [seller.id, bidder.id];
  const item = await createLiveItem(BASE, seller.token, "TC-10 Kafka Restart Test Item", { increment: INCREMENT });
  ctx.itemId = item.id;

  console.log(`==> Connecting ${VIEWERS} viewers + 1 bidder`);
  const viewers = Array.from({ length: VIEWERS }, (_, i) => new Viewer(`anon#${i}`, BASE, item.id));
  const bidderWs = new Viewer("bidder", BASE, item.id, { token: bidder.token });
  ctx.conns = [...viewers, bidderWs];
  await Promise.all(ctx.conns.map((v) => v.open()));
  await waitFor(() => ctx.conns.every((v) => v.got("sync")), 5000, "every viewer's sync");

  // phase: "before" | "down" | "recovering" (Kafka started, not yet proven) | "after"
  let phase = "before";
  let startedAt = 0;
  const results = [];
  let amount = 100; // createLiveItem's starting price
  const nextBid = async () => {
    amount += INCREMENT;
    // 60s: a bid Kafka took just as it came back can wait for bid-worker's
    // consumer to rejoin its group - late, but answered.
    const r = { ...(await bidAndWait(bidderWs, amount, 60000)), phase };
    results.push(r);
    console.log(`    [${r.phase.padEnd(10)}] bid ${r.amount} -> ${r.outcome}${r.reason ? ` (${r.reason})` : ""} in ${r.at - r.sentAt}ms`);
    return r;
  };

  console.log("==> Bidding with Kafka up");
  for (let i = 0; i < 3; i++) { await nextBid(); await sleep(300); }

  console.log(`==> Stopping Kafka for ${DOWN_MS / 1000}s while the bidder keeps bidding`);
  phase = "down";
  stopService("kafka");
  stopped = true;
  const downUntil = Date.now() + DOWN_MS;
  while (Date.now() < downUntil) { await nextBid(); await sleep(300); }

  console.log("==> Starting Kafka again (nothing else is restarted)");
  startService("kafka");
  startedAt = Date.now();
  phase = "recovering";
  let firstOk;
  const recoverDeadline = Date.now() + 120000;
  while (!firstOk && Date.now() < recoverDeadline) {
    const r = await nextBid();
    if (r.outcome === "accepted") firstOk = r; else await sleep(1000);
  }
  phase = "after";
  for (let i = 0; i < 3 && firstOk; i++) { await nextBid(); await sleep(300); }

  console.log("==> Results");
  const before = results.filter((r) => r.phase === "before");
  const down = results.filter((r) => r.phase === "down");
  const after = results.filter((r) => r.phase === "after");
  check(before.every((r) => r.outcome === "accepted"), `${before.length}/${before.length} bids accepted before the restart`);
  check(results.every((r) => r.outcome !== "none"), `every bid got an answer (${results.length} bids, ${results.filter((r) => r.outcome === "none").length} without one)`);
  const unavailable = down.filter((r) => r.reason === "service_unavailable");
  check(down.length > 0 && down.every((r) => r.outcome === "rejected" && r.reason === "service_unavailable"),
    `${unavailable.length}/${down.length} bids sent while Kafka was down were answered "service_unavailable" (bidder is told, not left waiting)`);
  check(!!firstOk, firstOk
    ? `bidding recovered on its own ${((firstOk.at - startedAt) / 1000).toFixed(1)}s after Kafka was started`
    : "bidding did not recover within 120s of Kafka starting");
  check(after.length > 0 && after.every((r) => r.outcome === "accepted"), `${after.filter((r) => r.outcome === "accepted").length}/${after.length} bids accepted after recovery`);
  const lat = after.map((r) => r.at - r.sentAt);
  if (lat.length) console.log(`    bid -> own price_update after recovery: p50=${percentile(lat, 50)}ms max=${Math.max(...lat)}ms`);

  // kafka-go keeps retrying a write after the api-server stopped waiting, so
  // a bid answered "service_unavailable" could land once Kafka is back and
  // win - unless the broker refuses it as too old (models.BidExpiry). Its
  // price_update would be the proof, so look for one.
  await sleep(3000);
  const acceptedSeen = [...new Set(bidderWs.events.filter((e) => e.type === "price_update").map((e) => e.price))].sort((a, b) => a - b);
  const late = acceptedSeen.filter((a) => results.find((r) => r.amount === a)?.outcome !== "accepted");
  check(late.length === 0, `no bid answered "service_unavailable" was accepted later (${late.length ? late.join(", ") : "none"})`);
  ctx.expectedBids = acceptedSeen.length;

  console.log("==> Checking Postgres, Redis and viewers");
  let db;
  await waitFor(() => { db = dbBids(item.id); return db.accepted.length >= acceptedSeen.length; }, 30000, "accepted bids in Postgres").catch(() => {});
  check(JSON.stringify(db.accepted) === JSON.stringify(acceptedSeen),
    `Postgres has exactly the ${acceptedSeen.length} accepted bids the bidder saw (db: ${db.accepted.length})`);
  check(db.dups === 0, `no bid recorded twice (${db.rows} rows, ${db.dups} duplicate request_ids)`);
  const redisPrice = Number(redisCli("HGET", `item:${item.id}:state`, "price").trim());
  check(redisPrice === acceptedSeen.at(-1), `Redis current price ${redisPrice} = last accepted bid ${acceptedSeen.at(-1)}`);
  const inOrder = viewers.filter((v) => JSON.stringify(v.events.filter((e) => e.type === "price_update").map((e) => e.price)) === JSON.stringify(acceptedSeen));
  check(inOrder.length === VIEWERS, `${inOrder.length}/${VIEWERS} viewers saw every accepted price, in order`);
} catch (e) {
  check(false, `test aborted: ${e.message}`);
} finally {
  ctx.conns.forEach((v) => v.close());
  if (stopped) {
    try { startService("kafka"); } catch (e) { console.log(`    (start kafka: ${e.message})`); }
  }
  console.log("==> Cleaning up test data");
  await cleanup(ctx).catch((e) => console.log(`    cleanup failed: ${e.message}`));
}

console.log(allPassed() ? "PASS: TC-10 a Kafka restart cost bidders a clear \"try again\", never a lost or duplicated bid" : "FAIL: TC-10");
process.exit(allPassed() ? 0 : 1);
