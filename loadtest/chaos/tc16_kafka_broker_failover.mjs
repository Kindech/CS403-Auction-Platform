// TC-16 Kafka Broker Failover (added - Kubernetes only: k8s/kafka.yaml runs
// 3 brokers with replication factor 3, min.insync.replicas 2 and acks=all).
//
// TC-10 stops all of Kafka, so bidding has to wait for a broker to start
// again. Here only one broker dies - the one leading the partition this
// item's bids go to - with SIGKILL, while a bidder keeps bidding (one bid at a
// time, waiting for each outcome like a user would). Checks:
//   - another broker takes over the partition, and bidding goes on without
//     waiting for the dead one to restart
//   - every bid gets an answer; any "service_unavailable" is honest (that bid
//     is never accepted later)
//   - no accepted bid is lost or recorded twice (acks=all: the new leader
//     already had every bid the old one confirmed)
//   - the killed broker comes back by itself and catches up (back in sync)
//
// Usage: TARGET=k8s node chaos/tc16_kafka_broker_failover.mjs
// Env:   BASE_URL (default http://localhost:8080), VIEWERS (default 10),
//        RUN_MS (how long to keep bidding after the kill, default 15000)
import { K8S, register, createLiveItem, waitFor, sleep, Viewer, check, allPassed, percentile, cleanup,
  redisCli, crashService, bidAndWait, dbBids, kafkaTopic, kafkaTopicAsync, kafkaEndOffsets, partitionFor } from "./lib.mjs";

const BASE = process.env.BASE_URL || "http://localhost:8080";
const VIEWERS = Number(process.env.VIEWERS || 10);
const RUN_MS = Number(process.env.RUN_MS || 15000);
const INCREMENT = 10;

if (!K8S) {
  console.log("TC-16 needs the 3-broker Kafka of k8s/ (compose runs one broker): run with TARGET=k8s");
  process.exit(1);
}

const ctx = { conns: [] };
try {
  // A broker that restarted recently (an earlier run, a rollout) may still be
  // catching up; start only once every replica is back in sync.
  let topic;
  const inSyncNow = () => { topic = kafkaTopic(); return Object.keys(topic).length === 6 && Object.values(topic).every((p) => p.isr.length === 3); };
  await waitFor(inSyncNow, 120000, "every replica in sync").catch(() => {});
  const inSync = Object.values(topic).every((p) => p.isr.length === 3);
  check(Object.keys(topic).length === 6 && inSync, `bid-requests: 6 partitions, every one on 3 brokers in sync (${Object.values(topic).map((p) => p.isr.length).join(",")})`);

  console.log("==> Creating throwaway users and a live item");
  const seller = await register(BASE, "tc16-seller", "Tc16 Seller");
  const bidder = await register(BASE, "tc16-bidder", "Tc16 Bidder");
  ctx.userIds = [seller.id, bidder.id];
  const item = await createLiveItem(BASE, seller.token, "TC-16 Kafka Broker Failover Test Item", { increment: INCREMENT });
  ctx.itemId = item.id;

  console.log(`==> Connecting ${VIEWERS} viewers + 1 bidder`);
  const viewers = Array.from({ length: VIEWERS }, (_, i) => new Viewer(`anon#${i}`, BASE, item.id));
  const bidderWs = new Viewer("bidder", BASE, item.id, { token: bidder.token });
  ctx.conns = [...viewers, bidderWs];
  await Promise.all(ctx.conns.map((v) => v.open()));
  await waitFor(() => ctx.conns.every((v) => v.got("sync")), 5000, "every viewer's sync");

  let phase = "before";
  const results = [];
  let amount = 100;
  const nextBid = async () => {
    amount += INCREMENT;
    const r = { ...(await bidAndWait(bidderWs, amount, 30000)), phase };
    results.push(r);
    console.log(`    [${r.phase.padEnd(6)}] bid ${r.amount} -> ${r.outcome}${r.reason ? ` (${r.reason})` : ""} in ${r.at - r.sentAt}ms`);
    return r;
  };

  console.log("==> Bidding with all brokers up, and finding this item's partition");
  const offsetsBefore = kafkaEndOffsets();
  for (let i = 0; i < 3; i++) { await nextBid(); await sleep(200); }
  const offsetsAfter = kafkaEndOffsets();
  const partition = Object.keys(offsetsAfter).find((p) => offsetsAfter[p] - (offsetsBefore[p] || 0) >= 3);
  check(partition !== undefined && Number(partition) === partitionFor(item.id),
    `the item's bids went to partition ${partition} (key hash says ${partitionFor(item.id)})`);
  const leader = kafkaTopic()[partition].leader;
  const pod = leader - 1;
  console.log(`    partition ${partition} is led by broker ${leader} (pod kafka-${pod})`);

  console.log(`==> Killing broker ${leader} (kafka-${pod}) with SIGKILL and bidding on for ${RUN_MS / 1000}s`);
  phase = "after";
  const code = crashService("kafka", pod);
  const killedAt = Date.now();
  check(code === 137, `kafka-${pod} was killed by SIGKILL (exit code ${code})`);
  // Ask a surviving broker who leads the partition now, without blocking the
  // bidder (each answer takes ~1s: kubectl exec + a JVM tool).
  const survivor = `kafka-${pod === 0 ? 1 : 0}`;
  let newLeader;
  const leaderWatch = (async () => {
    while (!newLeader && Date.now() - killedAt < RUN_MS) {
      const asked = Date.now();
      const l = await kafkaTopicAsync(survivor).then((t) => t[partition]?.leader).catch(() => undefined);
      if (l && l !== leader && l !== -1) newLeader = { id: l, ms: asked - killedAt };
      else await sleep(200);
    }
  })();
  while (Date.now() - killedAt < RUN_MS) { await nextBid(); await sleep(200); }
  await leaderWatch;

  console.log("==> Results");
  const before = results.filter((r) => r.phase === "before");
  const after = results.filter((r) => r.phase === "after");
  check(before.every((r) => r.outcome === "accepted"), `${before.length}/${before.length} bids accepted before the kill`);
  check(!!newLeader, newLeader
    ? `broker ${newLeader.id} took over partition ${partition} by ${(newLeader.ms / 1000).toFixed(1)}s after the kill (polled about once a second)`
    : `no other broker took over partition ${partition} within ${RUN_MS / 1000}s`);
  check(results.every((r) => r.outcome !== "none"), `every bid got an answer (${results.length} bids, ${results.filter((r) => r.outcome === "none").length} without one)`);
  const unavailable = after.filter((r) => r.reason === "service_unavailable");
  const firstOk = after.find((r) => r.outcome === "accepted");
  const stall = firstOk ? firstOk.at - killedAt : NaN;
  check(!!firstOk, firstOk
    ? `bidding went on: first bid after the kill accepted ${(stall / 1000).toFixed(1)}s after it (${unavailable.length} answered "service_unavailable" meanwhile)`
    : "no bid was accepted after the kill");
  const lastFail = [...after].reverse().find((r) => r.outcome !== "accepted");
  const tail = lastFail ? after.slice(after.indexOf(lastFail) + 1) : after;
  check(tail.length >= 5 && tail.every((r) => r.outcome === "accepted"), `the last ${tail.length} bids were all accepted, while the dead broker was still being restarted`);
  const lat = tail.map((r) => r.at - r.sentAt);
  if (lat.length) console.log(`    bid -> own price_update once failed over: p50=${percentile(lat, 50)}ms max=${Math.max(...lat)}ms`);

  await sleep(3000);
  const acceptedSeen = [...new Set(bidderWs.events.filter((e) => e.type === "price_update").map((e) => e.price))].sort((a, b) => a - b);
  const late = acceptedSeen.filter((a) => results.find((r) => r.amount === a)?.outcome !== "accepted");
  check(late.length === 0, `no bid answered "service_unavailable" was accepted later (${late.length ? late.join(", ") : "none"})`);

  console.log("==> Checking Postgres, Redis and viewers");
  let db;
  await waitFor(() => { db = dbBids(item.id); return db.accepted.length >= acceptedSeen.length; }, 30000, "accepted bids in Postgres").catch(() => {});
  check(JSON.stringify(db.accepted) === JSON.stringify(acceptedSeen),
    `Postgres has exactly the ${acceptedSeen.length} accepted bids the bidder saw (db: ${db.accepted.length})`);
  check(db.dups === 0, `no bid recorded twice (${db.rows} rows, ${db.dups} duplicate request_ids)`);
  ctx.expectedBids = db.rows;
  const redisPrice = Number(redisCli("HGET", `item:${item.id}:state`, "price").trim());
  check(redisPrice === acceptedSeen.at(-1), `Redis current price ${redisPrice} = last accepted bid ${acceptedSeen.at(-1)}`);
  const inOrder = viewers.filter((v) => JSON.stringify(v.events.filter((e) => e.type === "price_update").map((e) => e.price)) === JSON.stringify(acceptedSeen));
  check(inOrder.length === VIEWERS, `${inOrder.length}/${VIEWERS} viewers saw every accepted price, in order`);

  console.log(`==> Waiting for broker ${leader} to come back and catch up`);
  let caughtUp;
  await waitFor(() => { const t = kafkaTopic(); caughtUp = Object.values(t).length === 6 && Object.values(t).every((p) => p.isr.length === 3); return caughtUp; }, 120000, "all replicas in sync").catch(() => {});
  check(caughtUp, `broker ${leader} restarted by itself and every partition is on 3 brokers in sync again (${((Date.now() - killedAt) / 1000).toFixed(1)}s after the kill)`);
} catch (e) {
  check(false, `test aborted: ${e.message}`);
} finally {
  ctx.conns.forEach((v) => v.close());
  console.log("==> Cleaning up test data");
  await cleanup(ctx).catch((e) => console.log(`    cleanup failed: ${e.message}`));
}

console.log(allPassed() ? "PASS: TC-16 losing a Kafka broker moved its partitions to another, without losing or duplicating a bid" : "FAIL: TC-16");
process.exit(allPassed() ? 0 : 1);
