// TC-13 Auction Closing With a Backlog (added - proves the soft-close rule of
// report section 3.1.1 holds when bid-worker is behind: a bid placed before
// the deadline must count, even if the worker only reads it after the
// deadline has passed).
//
// bid-worker is stopped, bids are placed on ITEMS items before their end time
// and stay queued in Kafka, the end time passes, then the worker comes back.
// Finalizing used to race those bids: most were rejected as auction_not_live
// and their items ended with no winner. Checks:
//   - every in-time bid is accepted, none rejected
//   - the auction is extended rather than ended, since each bid landed inside
//     the anti-snipe window
//   - an item nobody bid on still closes normally, unsold
// bid-worker is always started again at the end, pass or fail.
//
// Usage: node chaos/tc13_close_with_backlog.mjs              (docker compose)
//        TARGET=k8s node chaos/tc13_close_with_backlog.mjs   (Kubernetes, k8s/)
// Env:   BASE_URL (default http://localhost:8080), ITEMS (default 8)
import { api, register, waitFor, sleep, Viewer, check, allPassed, cleanup, psql, stopWorker, startWorker } from "./lib.mjs";

const BASE = process.env.BASE_URL || "http://localhost:8080";
const ITEMS = Number(process.env.ITEMS || 8);
const DURATION_MS = 25000; // long enough to stop the worker and bid before the end
const AMOUNT = 100;

const createItem = (token, title) => {
  const now = Date.now();
  return api(BASE, "POST", "/items", {
    title, description: "", image_url: "", starting_price: AMOUNT, bid_increment: 10,
    start_time: new Date(now).toISOString(), end_time: new Date(now + DURATION_MS).toISOString(),
  }, token);
};

const items = [];
const conns = [];
let userIds = [];
let stopped = false;
try {
  console.log(`==> Creating throwaway users and ${ITEMS} items ending in ${DURATION_MS / 1000}s, plus one nobody bids on`);
  const seller = await register(BASE, "tc13-seller", "Tc13 Seller");
  const bidder = await register(BASE, "tc13-bidder", "Tc13 Bidder");
  userIds = [seller.id, bidder.id];
  for (let i = 0; i < ITEMS; i++) items.push(await createItem(seller.token, `TC-13 Backlog Item ${i}`));
  const unsold = await createItem(seller.token, "TC-13 Item Nobody Bids On");
  items.push(unsold);
  const bidItems = items.slice(0, ITEMS);
  const lastEnd = Math.max(...items.map((it) => new Date(it.end_time).getTime()));

  for (const it of bidItems) {
    const v = new Viewer(`bidder@${it.id}`, BASE, it.id, { token: bidder.token });
    await v.open();
    conns.push(v);
  }
  await waitFor(() => conns.every((v) => v.got("sync")), 10000, "every connection's sync");

  console.log("==> Stopping bid-worker, then bidding on every item before its end time");
  stopWorker();
  stopped = true;
  const firstEnd = Math.min(...bidItems.map((it) => new Date(it.end_time).getTime()));
  check(Date.now() < firstEnd - 1000, `bidding with ${((firstEnd - Date.now()) / 1000).toFixed(1)}s left (otherwise this test proves nothing)`);
  conns.forEach((v) => v.bid(AMOUNT));

  const waitMs = lastEnd - Date.now() + 4000;
  console.log(`==> Waiting ${(waitMs / 1000).toFixed(0)}s, until the end time has passed with the bids still queued`);
  await sleep(waitMs);

  console.log("==> Starting bid-worker again");
  startWorker();
  stopped = false;

  const answered = (v) => v.events.some((e) => e.type === "price_update" || e.type === "bid_rejected" || e.type === "auction_ended");
  await waitFor(() => conns.every(answered), 60000, "every bid's outcome").catch(() => {});
  conns.forEach((v, i) => {
    console.log(`    item ${i}: ${v.events.filter((e) => e.type !== "sync").map((e) => e.type + (e.reason ? `:${e.reason}` : "")).join(", ") || "(no answer)"}`);
  });

  const accepted = conns.filter((v) => v.got("price_update", (e) => e.price === AMOUNT)).length;
  check(accepted === ITEMS, `${accepted}/${ITEMS} bids placed in time were accepted`);
  const ended = conns.filter((v) => v.got("auction_ended")).length;
  check(ended === 0, `${ended}/${ITEMS} of those auctions ended under them (each bid extends its auction instead)`);
  await sleep(1500);
  const ids = bidItems.map((it) => `'${it.id}'`).join(",");
  const rows = psql(`SELECT count(*) FILTER (WHERE status='accepted') || '|' || count(*) FILTER (WHERE status='rejected') FROM bids WHERE item_id IN (${ids})`).split("|").map(Number);
  check(rows[0] === ITEMS && rows[1] === 0, `Postgres agrees: ${rows[0]} accepted, ${rows[1]} rejected`);

  let status;
  await waitFor(async () => { status = (await api(BASE, "GET", `/items/${unsold.id}`)).status; return status === "ended"; }, 30000, "the unsold item to close").catch(() => {});
  check(status === "ended", `the item nobody bid on still closed normally (status: ${status})`);
} catch (e) {
  check(false, `test aborted: ${e.message}`);
} finally {
  conns.forEach((v) => v.close());
  if (stopped) { try { startWorker(); } catch (e) { console.log(`    (start bid-worker: ${e.message})`); } }
  console.log("==> Cleaning up test data");
  await sleep(1500);
  for (const it of items) await cleanup({ itemId: it.id }).catch((e) => console.log(`    cleanup failed: ${e.message}`));
  await cleanup({ userIds }).catch((e) => console.log(`    cleanup failed: ${e.message}`));
}

console.log(allPassed() ? "PASS: TC-13 bids placed in time count, however far behind bid-worker is" : "FAIL: TC-13");
process.exit(allPassed() ? 0 : 1);
