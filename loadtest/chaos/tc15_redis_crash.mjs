// TC-15 Redis Crash (added - TC-12 stops Redis cleanly, so Redis saves before
// it exits. This one kills it, and then goes further than a kill can).
//
// Redis keeps live auction state with appendonly + appendfsync everysec. Three
// ways it can come back with less than it acknowledged, from mild to worst:
//   1. SIGKILL of the Redis process (no shutdown handler runs). Redis hands
//      each write to the OS before it replies, so the OS still holds it: the
//      AOF is expected to have every acknowledged bid.
//   2. An OS / power crash loses up to the last second of the AOF - the OS
//      never wrote it to disk. That can't be caused from inside a test, so it
//      is simulated: the item's state is rolled back to an earlier bid, exactly
//      what Redis looks like after losing that second. bid-worker must notice
//      that Postgres has a higher accepted bid and put it back before the next
//      bid is judged against the old price.
//   3. The state is gone altogether (volume lost): bid-worker rebuilds it from
//      Postgres.
// Two bidders take turns, so a rollback also changes who is leading.
//
// Usage: node chaos/tc15_redis_crash.mjs              (docker compose)
//        TARGET=k8s node chaos/tc15_redis_crash.mjs   (Kubernetes, k8s/)
// Env:   BASE_URL (default http://localhost:8080), VIEWERS (default 10),
//        CRASH_CMD (override how Redis is killed; must also bring it back)
import { register, createLiveItem, waitFor, sleep, Viewer, check, allPassed, cleanup,
  redisCli, crashService, bidAndWait, dbBids } from "./lib.mjs";

const BASE = process.env.BASE_URL || "http://localhost:8080";
const VIEWERS = Number(process.env.VIEWERS || 10);
const INCREMENT = 10;

const redisUp = () => { try { return redisCli("PING").trim() === "PONG"; } catch { return false; } };
const state = (itemId) => {
  const [price, bidder] = redisCli("HMGET", `item:${itemId}:state`, "price", "bidder_id").trim().split(/\r?\n/);
  return { price: Number(price), bidder: bidder || "" };
};

const ctx = { conns: [] };
try {
  console.log("==> Creating throwaway users and a live item");
  const seller = await register(BASE, "tc15-seller", "Tc15 Seller");
  const alice = await register(BASE, "tc15-alice", "Tc15 Alice");
  const bob = await register(BASE, "tc15-bob", "Tc15 Bob");
  ctx.userIds = [seller.id, alice.id, bob.id];
  const item = await createLiveItem(BASE, seller.token, "TC-15 Redis Crash Test Item", { increment: INCREMENT });
  ctx.itemId = item.id;

  console.log(`==> Connecting ${VIEWERS} viewers + 2 bidders`);
  const viewers = Array.from({ length: VIEWERS }, (_, i) => new Viewer(`anon#${i}`, BASE, item.id, { reconnect: true }));
  const bidders = [alice, bob].map((u) => Object.assign(new Viewer(u.name, BASE, item.id, { token: u.token, reconnect: true }), { user: u }));
  ctx.conns = [...viewers, ...bidders];
  await Promise.all(ctx.conns.map((v) => v.open()));
  await waitFor(() => ctx.conns.every((v) => v.got("sync")), 5000, "every viewer's sync");

  const results = [];
  let amount = 100;
  let turn = 0;
  const bid = async (phase, value = amount + INCREMENT) => {
    const who = bidders[turn++ % 2];
    const r = { ...(await bidAndWait(who, value, 10000)), phase, bidder: who.user.id };
    if (r.outcome === "accepted") amount = value;
    results.push(r);
    console.log(`    [${phase.padEnd(8)}] ${who.name} bids ${value} -> ${r.outcome}${r.reason ? ` (${r.reason})` : ""} in ${r.at - r.sentAt}ms`);
    return r;
  };
  const accepted = () => results.filter((r) => r.outcome === "accepted");
  const flushed = async (what) => {
    let db;
    await waitFor(() => { db = dbBids(item.id); return db.accepted.includes(amount); }, 15000, what).catch(() => {});
    return db;
  };

  console.log("==> Bidding");
  for (let i = 0; i < 3; i++) await bid("before");
  check(results.every((r) => r.outcome === "accepted"), "3/3 bids accepted before the crash");

  // ---- 1. SIGKILL ----
  console.log("==> 1. Killing Redis with SIGKILL right after a bid is acknowledged");
  const last = await bid("before");
  const code = crashService("redis");
  if (code !== null) check(code === 137, `Redis was killed by SIGKILL, no clean shutdown (exit code ${code})`);
  const killedAt = Date.now();
  await waitFor(redisUp, 120000, "Redis to come back");
  console.log(`    Redis answered again after ${((Date.now() - killedAt) / 1000).toFixed(1)}s`);
  const afterKill = state(item.id);
  check(afterKill.price === last.amount && afterKill.bidder === last.bidder,
    `Redis still has the last acknowledged bid after the kill (price ${afterKill.price}, expected ${last.amount})`);

  // api-server needs a moment to see Redis healthy again; bids in between are
  // answered service_unavailable (TC-12) and never recorded as accepted.
  const backAt = Date.now();
  await waitFor(async () => (await bid("recover")).outcome === "accepted" || (await sleep(500), false), 60000, "bidding to recover").catch(() => {});
  check(results.at(-1).outcome === "accepted", `bidding recovered ${((Date.now() - backAt) / 1000).toFixed(1)}s after Redis came back`);

  // ---- 2. lost last second of AOF (OS crash), simulated ----
  console.log("==> 2. Rolling Redis back to an earlier bid, as an OS crash losing the last second of AOF would");
  await flushed("Postgres to have the latest bid");
  const truth = accepted().at(-1);
  const older = accepted().at(-3); // other bidder was leading here, at a lower price
  redisCli("HSET", `item:${item.id}:state`, "price", String(older.amount), "bidder_id", older.bidder,
    "bidder_name", older.bidder === alice.id ? alice.name : bob.name);
  const rolledAt = Date.now();
  console.log(`    Redis now says ${older.amount}; Postgres says ${truth.amount}`);
  let fixed;
  await waitFor(() => { fixed = state(item.id); return fixed.price === truth.amount; }, 10000, "bid-worker to restore the state").catch(() => {});
  const restoreMs = Date.now() - rolledAt;
  check(fixed.price === truth.amount && fixed.bidder === truth.bidder,
    `bid-worker restored price ${fixed.price} and leader from Postgres in ${(restoreMs / 1000).toFixed(1)}s`);

  // A bid that beats the rolled-back price but not the real one must lose.
  const stale = await bid("stale", older.amount + INCREMENT);
  check(stale.outcome === "rejected" && stale.reason === "bid_too_low",
    `a bid of ${stale.amount} (enough for the lost state, not for the real price ${truth.amount}) was rejected as bid_too_low`);
  const ok2 = await bid("after");
  check(ok2.outcome === "accepted", `the next valid bid (${ok2.amount}) was accepted`);

  // ---- 3. state gone ----
  console.log("==> 3. Deleting the item's state from Redis altogether");
  await flushed("Postgres to have the latest bid");
  const truth3 = accepted().at(-1);
  redisCli("DEL", `item:${item.id}:state`);
  const deletedAt = Date.now();
  let rebuilt;
  await waitFor(() => { rebuilt = state(item.id); return rebuilt.price === truth3.amount; }, 10000, "bid-worker to rebuild the state").catch(() => {});
  check(rebuilt.price === truth3.amount && rebuilt.bidder === truth3.bidder,
    `bid-worker rebuilt price ${rebuilt.price} and leader from Postgres in ${((Date.now() - deletedAt) / 1000).toFixed(1)}s`);
  const ok3 = await bid("after");
  check(ok3.outcome === "accepted", `bidding continued at the right price (${ok3.amount} accepted)`);

  // ---- end state ----
  console.log("==> Checking Postgres and viewers");
  const db = await flushed("Postgres to have every accepted bid");
  const seen = accepted().map((r) => r.amount);
  check(JSON.stringify(db.accepted) === JSON.stringify(seen),
    `Postgres has exactly the ${seen.length} bids the bidders saw accepted (db: ${db.accepted.join(", ")})`);
  check(db.dups === 0, `no bid recorded twice (${db.rows} rows, ${db.dups} duplicate request_ids)`);
  await waitFor(() => viewers.every((v) => v.got("price_update", (e) => e.price === ok3.amount)), 10000, "viewers").catch(() => {});
  const saw = viewers.filter((v) => v.got("price_update", (e) => e.price === ok3.amount)).length;
  check(saw === VIEWERS, `${saw}/${VIEWERS} viewers saw the final price ${ok3.amount}`);
  ctx.expectedBids = db.rows; // api-server's own service_unavailable answers never reach Postgres
} catch (e) {
  check(false, `test aborted: ${e.message}`);
} finally {
  ctx.conns.forEach((v) => v.close());
  await waitFor(redisUp, 120000, "Redis").catch(() => {});
  console.log("==> Cleaning up test data");
  await cleanup(ctx).catch((e) => console.log(`    cleanup failed: ${e.message}`));
}

console.log(allPassed() ? "PASS: TC-15 Redis lost no accepted bid, and state it did lose came back from Postgres" : "FAIL: TC-15");
process.exit(allPassed() ? 0 : 1);
