// TC-14 Item Deleted Mid-Auction (added - a live item removed by hand, e.g. in
// pgAdmin, while someone is still connected).
//
// A bid on the deleted item can never be written (its foreign key is gone).
// bid-worker used to retry that batch forever, so no bid on ANY item reached
// Postgres again, even across worker restarts. Checks:
//   - bids on other items keep reaching Postgres
//   - Kafka consumer lag returns to 0, so nothing is stuck for replay
//   - the unwritable bid is on record in audit_log as bid.dropped
//   - the deleted item stops accepting bids
//
// Usage: node chaos/tc14_deleted_item.mjs              (docker compose)
//        TARGET=k8s node chaos/tc14_deleted_item.mjs   (Kubernetes, k8s/)
// Env:   BASE_URL (default http://localhost:8080)
import { register, createLiveItem, waitFor, sleep, Viewer, check, allPassed, cleanup, psql, kafkaLag, bidAndWait, dbBids } from "./lib.mjs";

const BASE = process.env.BASE_URL || "http://localhost:8080";

const conns = [];
let doomed, other;
let userIds = [];
try {
  console.log("==> Creating throwaway users and two live items");
  const seller = await register(BASE, "tc14-seller", "Tc14 Seller");
  const bidder = await register(BASE, "tc14-bidder", "Tc14 Bidder");
  userIds = [seller.id, bidder.id];
  doomed = await createLiveItem(BASE, seller.token, "TC-14 Item That Gets Deleted");
  other = await createLiveItem(BASE, seller.token, "TC-14 Unrelated Item");

  const onDoomed = new Viewer("doomed", BASE, doomed.id, { token: bidder.token });
  const onOther = new Viewer("other", BASE, other.id, { token: bidder.token });
  conns.push(onDoomed, onOther);
  await Promise.all(conns.map((v) => v.open()));
  await waitFor(() => conns.every((v) => v.got("sync")), 5000, "sync");

  console.log("==> Deleting one live item straight from Postgres, then bidding on both");
  psql(`DELETE FROM audit_log WHERE entity_id='${doomed.id}'; DELETE FROM items WHERE id='${doomed.id}'`);
  await bidAndWait(onDoomed, 100);
  const first = await bidAndWait(onOther, 100);
  const second = await bidAndWait(onOther, 110);
  check(first.outcome === "accepted" && second.outcome === "accepted", "bids on the unrelated item were accepted");

  let rows = 0;
  await waitFor(() => { rows = dbBids(other.id).accepted.length; return rows === 2; }, 20000, "the unrelated item's bids in Postgres").catch(() => {});
  check(rows === 2, `the unrelated item's bids reached Postgres (${rows}/2 rows)`);

  let lag;
  await waitFor(() => { lag = kafkaLag(); return lag === 0; }, 20000, "consumer lag 0").catch(() => {});
  check(lag === 0, `nothing is stuck in Kafka (consumer lag ${lag})`);

  const dropped = Number(psql(`SELECT count(*) FROM audit_log WHERE entity_id='${doomed.id}' AND action='bid.dropped'`));
  check(dropped >= 1, `the unwritable bid is recorded in audit_log as bid.dropped (${dropped})`);

  await sleep(500);
  const late = await bidAndWait(onDoomed, 200);
  check(late.outcome === "rejected" && late.reason === "auction_not_live", `the deleted item stopped accepting bids (${late.outcome}${late.reason ? `: ${late.reason}` : ""})`);
} catch (e) {
  check(false, `test aborted: ${e.message}`);
} finally {
  conns.forEach((v) => v.close());
  console.log("==> Cleaning up test data");
  await sleep(1500);
  if (doomed) await cleanup({ itemId: doomed.id }).catch((e) => console.log(`    cleanup failed: ${e.message}`));
  if (other) await cleanup({ itemId: other.id }).catch((e) => console.log(`    cleanup failed: ${e.message}`));
  await cleanup({ userIds }).catch((e) => console.log(`    cleanup failed: ${e.message}`));
}

console.log(allPassed() ? "PASS: TC-14 one deleted item can't stop bids on the others from being recorded" : "FAIL: TC-14");
process.exit(allPassed() ? 0 : 1);
