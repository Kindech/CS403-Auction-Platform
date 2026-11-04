// TC-09 API Server Failover (added - validates that the api tier has no
// single point of failure: report section 2.5.9 horizontal scaling + 3.6.3
// "no page reload").
//
// Connects viewers through nginx (so they spread across api-1 and api-2),
// then SIGKILLs api-1 mid-auction, the way a crashed process or a deleted
// Kubernetes pod would vanish. Viewers reconnect exactly like the frontend
// does (useAuctionSocket: retry after 1s, doubling to 10s) and the test checks:
//   - the kill actually dropped some viewers (otherwise it proved nothing)
//   - every dropped viewer reconnected through nginx and got a "sync" with
//     the current price - no stale state, no page reload
//   - a bid placed after the crash reaches every viewer
//   - REST keeps answering while api-1 is down
// api-1 is always restarted at the end, pass or fail.
//
// Usage: node chaos/tc09_api_failover.mjs              (docker compose)
//        TARGET=k8s node chaos/tc09_api_failover.mjs   (Kubernetes, k8s/)
// On Kubernetes the oldest api-server pod is force-deleted (no graceful
// shutdown, like a node or process dying); "restore" is just waiting for the
// Deployment to have replaced it - nobody restarts anything by hand.
// Env:   BASE_URL (default http://localhost:8080 - nginx), VIEWERS (default 100)
//        compose only: KILL_CMD / RESTORE_CMD override how the instance is
//        killed/restored (defaults: docker compose kill -s SIGKILL api-1 /
//        docker compose start api-1)
import { api, register, createLiveItem, waitFor, sleep, runCmd, Viewer, check, allPassed, percentile, cleanup,
  K8S, kubectl, apiPods } from "./lib.mjs";

const BASE = process.env.BASE_URL || "http://localhost:8080";
const VIEWERS = Number(process.env.VIEWERS || 100);
// The test itself takes ~4s, shorter than Prometheus's 5s scrape: on K8s the
// viewers are held HOLD_MS before the crash and again after recovery, so
// Grafana's "WebSocket connections per pod" shows them split over both pods,
// then all on the survivor.
const HOLD_MS = Number(process.env.HOLD_MS ?? (K8S ? 15000 : 0));
const hold = async (why) => {
  if (HOLD_MS <= 0) return;
  console.log(`    holding ${HOLD_MS / 1000}s ${why}, so Prometheus/Grafana record it`);
  await sleep(HOLD_MS);
};

let podsBefore = [];
let victim;
const kill = () => {
  if (!K8S) return runCmd(process.env.KILL_CMD, ["kill", "-s", "SIGKILL", "api-1"]);
  podsBefore = apiPods();
  victim = podsBefore[0];
  console.log(`    force-deleting pod ${victim} (of ${podsBefore.length})`);
  kubectl("delete", "pod", victim, "--grace-period=0", "--force", "--wait=false");
};
const restore = async () => {
  if (!K8S) return runCmd(process.env.RESTORE_CMD, ["start", "api-1"]);
  await waitFor(() => { const p = apiPods(); return p.length >= podsBefore.length && !p.includes(victim); }, 90000, "the Deployment to replace the pod");
  const replacement = apiPods().filter((p) => !podsBefore.includes(p));
  check(replacement.length > 0, `Kubernetes replaced ${victim} with ${replacement.join(", ")} on its own`);
};

let ctx = { conns: [] };
let killed = false;
try {
  console.log("==> Creating throwaway users and a live item");
  const seller = await register(BASE, "tc09-seller", "Tc09 Seller");
  const bidder = await register(BASE, "tc09-bidder", "Tc09 Bidder");
  ctx.userIds = [seller.id, bidder.id];
  const item = await createLiveItem(BASE, seller.token, "TC-09 API Failover Test Item");
  ctx.itemId = item.id;

  console.log(`==> Connecting ${VIEWERS} viewers + 1 bidder through nginx (round-robin over api-1/api-2)`);
  const viewers = Array.from({ length: VIEWERS }, (_, i) => new Viewer(`anon#${i}`, BASE, item.id, { reconnect: true }));
  const bidderWs = new Viewer("bidder", BASE, item.id, { token: bidder.token, reconnect: true });
  ctx.conns = [...viewers, bidderWs];
  await Promise.all(ctx.conns.map((v) => v.open()));
  await waitFor(() => ctx.conns.every((v) => v.got("sync")), 5000, "every viewer's sync");

  console.log("==> Bid 150 before the crash");
  bidderWs.bid(150);
  await waitFor(() => viewers.every((v) => v.got("price_update", (e) => e.price === 150)), 5000, "price_update 150 everywhere");
  check(true, `all ${VIEWERS} viewers got price 150 before the crash`);
  await hold("with the viewers spread over both pods");

  console.log(K8S ? "==> Killing an api-server pod" : "==> SIGKILL api-1");
  const killedAt = Date.now();
  kill();
  killed = true;
  await waitFor(() => ctx.conns.some((v) => v.closes > 0), 5000, "dropped connections").catch(() => {});
  await sleep(500);
  const dropped = ctx.conns.filter((v) => v.closes > 0);
  check(dropped.length > 0, `the crash dropped ${dropped.length}/${ctx.conns.length} connections (the ones that were on the killed instance)`);

  const got = await api(BASE, "GET", `/items/${item.id}`).catch(() => null);
  check(got?.id === item.id, "REST GET /api/items/{id} still answers through nginx right after the crash");

  console.log("==> Waiting for dropped viewers to reconnect via nginx");
  const resynced = (v) => v.events.some((e) => e.type === "sync" && e.conn > 1 && e.price === 150);
  await waitFor(() => dropped.every(resynced), 30000, "dropped viewers to resync").catch(() => {});
  const ok = dropped.filter(resynced);
  check(ok.length === dropped.length, `${ok.length}/${dropped.length} dropped connections reconnected and got sync with the current price (150)`);
  const reconnectMs = ok.map((v) => v.events.find((e) => e.type === "sync" && e.conn > 1).at - killedAt);
  if (reconnectMs.length) console.log(`    time from crash to resynced: p50=${percentile(reconnectMs, 50)}ms max=${Math.max(...reconnectMs)}ms`);

  console.log("==> Bid 200 after the crash");
  await waitFor(() => bidderWs.ws.readyState === WebSocket.OPEN, 15000, "bidder connection");
  const sentAt = Date.now();
  bidderWs.bid(200);
  await waitFor(() => viewers.every((v) => v.got("price_update", (e) => e.price === 200)), 5000, "price_update 200").catch(() => {});
  const got200 = viewers.filter((v) => v.got("price_update", (e) => e.price === 200));
  check(got200.length === VIEWERS, `${got200.length}/${VIEWERS} viewers got the post-crash bid (200)`);
  const lat = got200.map((v) => v.got("price_update", (e) => e.price === 200).at - sentAt);
  if (lat.length) console.log(`    delivery latency after failover: p50=${percentile(lat, 50)}ms max=${Math.max(...lat)}ms`);
  ctx.expectedBids = 2;
  await hold("with every viewer on the surviving pod(s)");
} catch (e) {
  check(false, `test aborted: ${e.message}`);
} finally {
  ctx.conns.forEach((v) => v.close());
  if (killed) {
    console.log(K8S ? "==> Waiting for Kubernetes to replace the pod" : "==> Restarting api-1");
    try { await restore(); } catch (e) { check(false, `restore failed: ${e.message}`); }
  }
  console.log("==> Cleaning up test data");
  await cleanup(ctx).catch((e) => console.log(`    cleanup failed: ${e.message}`));
}

console.log(allPassed() ? "PASS: TC-09 losing an api-server cost viewers a reconnect, never stale state or a missed bid" : "FAIL: TC-09");
process.exit(allPassed() ? 0 : 1);
