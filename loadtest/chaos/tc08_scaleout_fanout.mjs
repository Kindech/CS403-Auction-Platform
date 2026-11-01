// TC-08 Scale-out Fan-out (added - validates report section 2.5.9's
// horizontal-scaling claim against the Redis Pub/Sub broadcast path).
//
// Starts an extra api-server (api-3) that no configuration anywhere lists,
// spreads viewers across api-1, api-2 and api-3, then bids through different
// instances and checks that:
//   - every viewer on every instance gets every price_update (none missed)
//   - targeted events (outbid, bid_rejected) reach only their one recipient,
//     even when that recipient is on the new instance
//   - names stay masked for everyone but their owner
// and reports bid -> viewer delivery latency across instances.
//
// Usage: node chaos/tc08_scaleout_fanout.mjs              (docker compose)
//        TARGET=k8s node chaos/tc08_scaleout_fanout.mjs   (Kubernetes, k8s/)
// On Kubernetes the extra pod is added by the HorizontalPodAutoscaler itself:
// the test raises the HPA's minReplicas by one, waits for the new pod, and
// reaches each pod through its own kubectl port-forward. minReplicas is put
// back afterward and the HPA removes the pod again.
// Env:   VIEWERS_PER_INSTANCE (default 50)
//        compose only: SCALE_UP_CMD / SCALE_DOWN_CMD override how the extra
//        instance is started/removed (default: docker compose run/rm of
//        api-3 on :8083); API_URLS lists every instance's URL, new one last
import { execFileSync } from "node:child_process";
import { api, register, createLiveItem, waitFor, sleep, runCmd, Viewer, check, allPassed, percentile, cleanup,
  K8S, kubectl, apiPods, portForward } from "./lib.mjs";

const PER_INSTANCE = Number(process.env.VIEWERS_PER_INSTANCE || 50);
let URLS, NEW_URL, OLD_URL;

// Each returns { urls, teardown }, with the new instance's URL last.
async function scaleUpCompose() {
  const urls = (process.env.API_URLS || "http://localhost:8081,http://localhost:8082,http://localhost:8083").split(",");
  const down = () => {
    if (process.env.SCALE_DOWN_CMD) return runCmd(process.env.SCALE_DOWN_CMD);
    try { execFileSync("docker", ["rm", "-f", "deploy-api-3"], { stdio: "ignore" }); } catch {}
  };
  down(); // leftover from an interrupted run
  runCmd(process.env.SCALE_UP_CMD, ["run", "-d", "--no-deps", "--name", "deploy-api-3", "-p", "8083:8080", "api-1"]);
  const newUrl = urls[urls.length - 1];
  await waitFor(async () => (await fetch(`${newUrl}/healthz`).catch(() => ({ ok: false }))).ok, 30000, `${newUrl} to become healthy`);
  return { urls, teardown: down };
}

async function scaleUpK8s() {
  const origMin = Number(kubectl("get", "hpa", "api-server", "-o", "jsonpath={.spec.minReplicas}"));
  const before = apiPods();
  const setMin = (n) => kubectl("patch", "hpa", "api-server", "--type=merge", "-p", JSON.stringify({ spec: { minReplicas: n } }));
  setMin(before.length + 1);
  const forwards = [];
  const teardown = () => { forwards.forEach((f) => f.close()); setMin(origMin); };
  try {
    console.log(`    HPA minReplicas ${origMin} -> ${before.length + 1}; waiting for the HPA to add a pod`);
    await waitFor(() => apiPods().some((p) => !before.includes(p)), 90000, "the HPA to add a ready pod");
    const added = apiPods().filter((p) => !before.includes(p));
    const pods = [...before, added[0]];
    for (const [i, pod] of pods.entries()) forwards.push(await portForward(pod, 18081 + i));
    forwards.forEach((f) => console.log(`    ${f.url} -> pod ${f.pod}${f.pod === added[0] ? " (added by HPA)" : ""}`));
    return { urls: forwards.map((f) => f.url), teardown };
  } catch (e) {
    teardown();
    throw e;
  }
}

let ctx = {};
let viewers = [];
let scaled;
try {
  console.log(K8S ? "==> Having the HPA add an api-server pod" : "==> Starting an extra api-server instance that no config knows about");
  scaled = K8S ? await scaleUpK8s() : await scaleUpCompose();
  URLS = scaled.urls;
  NEW_URL = URLS[URLS.length - 1];
  OLD_URL = URLS[0];
  console.log(`    new instance at ${NEW_URL} is up`);

  console.log("==> Creating throwaway users and a live item");
  const seller = await register(OLD_URL, "tc08-seller", "Tc08 Seller");
  const alpha = await register(OLD_URL, "tc08-alpha", "Tc08 Alpha"); // bids from the NEW instance
  const beta = await register(OLD_URL, "tc08-beta", "Tc08 Beta");    // bids from an original instance
  ctx.userIds = [seller.id, alpha.id, beta.id];
  const item = await createLiveItem(OLD_URL, seller.token, "TC-08 Scale-out Test Item");
  ctx.itemId = item.id;

  console.log(`==> Connecting ${PER_INSTANCE} anonymous viewers to each of ${URLS.length} instances`);
  for (const url of URLS) {
    for (let i = 0; i < PER_INSTANCE; i++) viewers.push(new Viewer(`anon#${i}@${url}`, url, item.id));
  }
  const alphaWs = new Viewer("alpha@new", NEW_URL, item.id, { token: alpha.token });
  const betaWs = new Viewer("beta@old", OLD_URL, item.id, { token: beta.token });
  const everyone = [...viewers, alphaWs, betaWs];
  ctx.conns = everyone;
  await Promise.all(everyone.map((v) => v.open()));
  await waitFor(() => everyone.every((v) => v.got("sync")), 5000, "every viewer's sync");

  const deliver = async (who, amount) => {
    const sentAt = Date.now();
    who.bid(amount);
    await waitFor(() => everyone.every((v) => v.got("price_update", (e) => e.price === amount)), 5000, `price_update ${amount} on every connection`)
      .catch(() => {});
    return everyone.map((v) => v.got("price_update", (e) => e.price === amount)).filter(Boolean).map((e) => e.at - sentAt);
  };

  console.log("==> alpha bids 150 from the NEW instance, beta outbids with 200 from an original one");
  const lat150 = await deliver(alphaWs, 150);
  const lat200 = await deliver(betaWs, 200);
  alphaWs.bid(50); // too low -> bid_rejected, for alpha only
  await waitFor(() => alphaWs.got("bid_rejected"), 5000, "alpha's bid_rejected").catch(() => {});
  await sleep(500); // give any wrongly-routed targeted event time to show up

  console.log("==> Results");
  for (const url of URLS) {
    const onIt = viewers.filter((v) => v.base === url);
    const ok = onIt.filter((v) => v.got("price_update", (e) => e.price === 150) && v.got("price_update", (e) => e.price === 200)).length;
    check(ok === onIt.length, `${url}${url === NEW_URL ? " (new instance)" : ""}: ${ok}/${onIt.length} viewers got both price_updates`);  }
  check(alphaWs.got("outbid", (e) => e.price === 200) !== undefined, "alpha (on the new instance) got its targeted outbid");
  check(alphaWs.got("bid_rejected") !== undefined, "alpha (on the new instance) got its targeted bid_rejected");
  const leaked = everyone.filter((v) => v !== alphaWs && (v.got("outbid") || v.got("bid_rejected")));
  check(leaked.length === 0, `targeted events reached nobody else (${leaked.length} leaks)`);
  const anon150 = viewers[0].got("price_update", (e) => e.price === 150);
  const own150 = alphaWs.got("price_update", (e) => e.price === 150);
  check(own150?.bidder_name === "Tc08 Alpha" && anon150?.bidder_name === "T***a",
    `name unmasked for its owner ("${own150?.bidder_name}"), masked for others ("${anon150?.bidder_name}")`);

  const lat = [...lat150, ...lat200];
  console.log(`    delivery latency bid -> viewer over ${lat.length} deliveries: p50=${percentile(lat, 50)}ms p95=${percentile(lat, 95)}ms max=${Math.max(...lat)}ms`);
  ctx.expectedBids = 3;
} catch (e) {
  check(false, `test aborted: ${e.message}`);
} finally {
  (ctx.conns || viewers).forEach((v) => v.close());
  console.log("==> Removing the extra instance and cleaning up test data");
  try { scaled?.teardown(); } catch (e) { console.log(`    teardown failed: ${e.message}`); }
  await cleanup({ itemId: ctx.itemId, userIds: ctx.userIds, expectedBids: ctx.expectedBids }).catch((e) => console.log(`    cleanup failed: ${e.message}`));
}

console.log(allPassed() ? "PASS: TC-08 every instance, old and new, received every event" : "FAIL: TC-08");
process.exit(allPassed() ? 0 : 1);
