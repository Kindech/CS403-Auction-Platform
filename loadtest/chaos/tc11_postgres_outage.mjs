// TC-11 Postgres Outage (added - tests the claim the architecture is built
// on: Postgres is only the durable record, so losing it may delay the record
// but must never stop live bidding; report section 2.6.4).
//
// A bidder keeps bidding (one bid at a time, waiting for each outcome) while
// Postgres is stopped for DOWN_MS and started again. Checks:
//   - bidding never stops: bids sent during the outage are accepted and
//     broadcast with real-time latency (Redis + Kafka only)
//   - every viewer saw every accepted price, in order
//   - after Postgres returns, bid-worker writes the backlog by itself:
//     Postgres ends up with exactly the accepted bids, once each
//   - Kafka offsets get committed after that write (consumer lag back to 0),
//     so nothing is left to replay
//   - audit_log has a bid.accepted entry for every accepted bid
// Postgres is always started again at the end, pass or fail.
//
// Usage: node chaos/tc11_postgres_outage.mjs              (docker compose)
//        TARGET=k8s node chaos/tc11_postgres_outage.mjs   (Kubernetes, k8s/)
// Env:   BASE_URL (default http://localhost:8080), VIEWERS (default 20),
//        DOWN_MS (default 15000), STOP_CMD / START_CMD (override how Postgres
//        is stopped/started)
import { register, createLiveItem, waitFor, sleep, Viewer, check, allPassed, percentile, cleanup,
  psql, redisCli, stopService, startService, bidAndWait, dbBids, kafkaLag } from "./lib.mjs";

const BASE = process.env.BASE_URL || "http://localhost:8080";
const VIEWERS = Number(process.env.VIEWERS || 20);
const DOWN_MS = Number(process.env.DOWN_MS || 15000);
const INCREMENT = 10;

const ctx = { conns: [] };
let stopped = false;
try {
  console.log("==> Creating throwaway users and a live item");
  const seller = await register(BASE, "tc11-seller", "Tc11 Seller");
  const bidder = await register(BASE, "tc11-bidder", "Tc11 Bidder");
  ctx.userIds = [seller.id, bidder.id];
  const item = await createLiveItem(BASE, seller.token, "TC-11 Postgres Outage Test Item", { increment: INCREMENT });
  ctx.itemId = item.id;

  console.log(`==> Connecting ${VIEWERS} viewers + 1 bidder`);
  const viewers = Array.from({ length: VIEWERS }, (_, i) => new Viewer(`anon#${i}`, BASE, item.id));
  const bidderWs = new Viewer("bidder", BASE, item.id, { token: bidder.token });
  ctx.conns = [...viewers, bidderWs];
  await Promise.all(ctx.conns.map((v) => v.open()));
  await waitFor(() => ctx.conns.every((v) => v.got("sync")), 5000, "every viewer's sync");

  let phase = "before";
  const results = [];
  let amount = 100; // createLiveItem's starting price
  const nextBid = async () => {
    amount += INCREMENT;
    const r = { ...(await bidAndWait(bidderWs, amount)), phase };
    results.push(r);
    console.log(`    [${r.phase.padEnd(6)}] bid ${r.amount} -> ${r.outcome}${r.reason ? ` (${r.reason})` : ""} in ${r.at - r.sentAt}ms`);
    return r;
  };

  console.log("==> Bidding with Postgres up");
  for (let i = 0; i < 3; i++) { await nextBid(); await sleep(300); }

  console.log(`==> Stopping Postgres for ${DOWN_MS / 1000}s while the bidder keeps bidding`);
  stopService("postgres");
  stopped = true;
  phase = "down";
  const downUntil = Date.now() + DOWN_MS;
  while (Date.now() < downUntil) { await nextBid(); await sleep(300); }
  const rest = await fetch(`${BASE}/api/items/${item.id}`).then((r) => r.status).catch(() => "error");
  console.log(`    (REST GET /api/items/{id} during the outage -> ${rest}: reads that need Postgres fail until it is back)`);

  console.log("==> Starting Postgres again (nothing else is restarted)");
  startService("postgres");
  stopped = false;
  const startedAt = Date.now();
  await waitFor(() => { try { return psql("SELECT 1") === "1"; } catch { return false; } }, 120000, "Postgres to accept connections");
  phase = "after";
  for (let i = 0; i < 3; i++) { await nextBid(); await sleep(300); }

  console.log("==> Results");
  const down = results.filter((r) => r.phase === "down");
  check(results.every((r) => r.outcome === "accepted"), `${results.filter((r) => r.outcome === "accepted").length}/${results.length} bids accepted, before, during and after the outage`);
  check(down.length >= 3 && down.every((r) => r.outcome === "accepted"), `${down.filter((r) => r.outcome === "accepted").length}/${down.length} bids accepted while Postgres was down`);
  const latBefore = results.filter((r) => r.phase === "before").map((r) => r.at - r.sentAt);
  const latDown = down.map((r) => r.at - r.sentAt);
  console.log(`    bid -> own price_update: before p50=${percentile(latBefore, 50)}ms, during outage p50=${percentile(latDown, 50)}ms max=${Math.max(...latDown)}ms`);
  check(Math.max(...latDown) < 1000, `bids stayed real-time during the outage (slowest ${Math.max(...latDown)}ms, limit 1000ms)`);

  const acceptedSeen = results.filter((r) => r.outcome === "accepted").map((r) => r.amount);
  ctx.expectedBids = acceptedSeen.length;
  const inOrder = viewers.filter((v) => JSON.stringify(v.events.filter((e) => e.type === "price_update").map((e) => e.price)) === JSON.stringify(acceptedSeen));
  check(inOrder.length === VIEWERS, `${inOrder.length}/${VIEWERS} viewers saw every accepted price, in order`);

  console.log("==> Waiting for bid-worker to write the backlog");
  let db;
  await waitFor(() => { db = dbBids(item.id); return db.accepted.length >= acceptedSeen.length; }, 60000, "accepted bids in Postgres").catch(() => {});
  console.log(`    backlog written ${((Date.now() - startedAt) / 1000).toFixed(1)}s after Postgres was started`);
  check(JSON.stringify(db.accepted) === JSON.stringify(acceptedSeen),
    `Postgres has exactly the ${acceptedSeen.length} accepted bids, incl. the ${down.length} from the outage (db: ${db.accepted.length})`);
  check(db.dups === 0, `no bid recorded twice (${db.rows} rows, ${db.dups} duplicate request_ids)`);
  const redisPrice = Number(redisCli("HGET", `item:${item.id}:state`, "price").trim());
  check(redisPrice === acceptedSeen.at(-1), `Redis current price ${redisPrice} = last accepted bid ${acceptedSeen.at(-1)}`);

  let lag;
  await waitFor(() => { lag = kafkaLag(); return lag === 0; }, 20000, "consumer lag 0").catch(() => {});
  check(lag === 0, `bid-worker committed its Kafka offsets after the write (consumer lag ${lag})`);

  await sleep(1000);
  const audited = Number(psql(`SELECT count(*) FROM audit_log WHERE entity_id='${item.id}' AND action='bid.accepted'`));
  check(audited === acceptedSeen.length, `audit_log has ${audited}/${acceptedSeen.length} bid.accepted entries`);
} catch (e) {
  check(false, `test aborted: ${e.message}`);
} finally {
  ctx.conns.forEach((v) => v.close());
  if (stopped) {
    try { startService("postgres"); } catch (e) { console.log(`    (start postgres: ${e.message})`); }
    await waitFor(() => { try { return psql("SELECT 1") === "1"; } catch { return false; } }, 120000, "Postgres").catch(() => {});
  }
  console.log("==> Cleaning up test data");
  await cleanup(ctx).catch((e) => console.log(`    cleanup failed: ${e.message}`));
}

console.log(allPassed() ? "PASS: TC-11 a Postgres outage delayed the record, never live bidding" : "FAIL: TC-11");
process.exit(allPassed() ? 0 : 1);
