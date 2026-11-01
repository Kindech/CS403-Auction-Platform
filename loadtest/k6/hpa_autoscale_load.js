// HPA autoscale load (Kubernetes demo, not one of the report's TCs).
// Sustained "everyone is browsing the auction" traffic - item list, item
// page, bid history - long enough for the HorizontalPodAutoscaler in
// k8s/api-server.yaml to see api-server CPU above its 50% target, add pods,
// and later remove them once the load stops. Run it inside the cluster with
// k8s/run-k6.ps1 and watch `kubectl -n auction get hpa,pods -w` meanwhile.
import http from "k6/http";
import { check, sleep } from "k6";
import { login, freshItem } from "./lib/common.js";

const VUS = Number(__ENV.VUS || 300);
const HOLD = __ENV.HOLD || "2m";

export const options = {
  scenarios: {
    browse: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "20s", target: VUS },
        { duration: HOLD, target: VUS },
        { duration: "10s", target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    checks: ["rate>0.99"],
  },
};

export function setup() {
  const seller = login("seller@example.com", "password123");
  const item = freshItem(seller.token, { title: "HPA Autoscale Load Item", startingPrice: 100, bidIncrement: 1, durationSec: 600 });
  return { itemId: item.id };
}

export default function (data) {
  const base = __ENV.BASE_URL || "http://localhost:8080";
  const res = http.batch([
    ["GET", `${base}/api/items`],
    ["GET", `${base}/api/items/${data.itemId}`],
    ["GET", `${base}/api/items/${data.itemId}/bids`],
  ]);
  check(res[0], { "list items 200": (r) => r.status === 200 });
  check(res[1], { "get item 200": (r) => r.status === 200 });
  sleep(0.2);
}
