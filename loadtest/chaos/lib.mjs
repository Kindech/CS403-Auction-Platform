// Shared helpers for the Node-based chaos/scale tests (TC-08 to TC-11).
// Requires Node 22+ (global WebSocket and fetch).
//
// TARGET=k8s runs them against the Kubernetes deployment in k8s/ (namespace
// "auction") instead of the docker compose stack: database cleanup goes
// through kubectl exec, and the tests scale/kill pods instead of containers.
import { execFileSync, execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const COMPOSE_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../deploy/docker-compose.yml");
export const K8S = process.env.TARGET === "k8s";
const NS = process.env.K8S_NAMESPACE || "auction";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function kubectl(...args) {
  return execFileSync("kubectl", ["-n", NS, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// apiPods lists running, ready api-server pods, oldest first.
export function apiPods() {
  const out = kubectl("get", "pods", "-l", "app=api-server", "--sort-by=.metadata.creationTimestamp",
    "-o", "jsonpath={range .items[*]}{.metadata.name} {.metadata.deletionTimestamp} {.status.containerStatuses[0].ready}{\"\\n\"}{end}");
  return out.trim().split("\n").map((l) => l.trim().split(/\s+/)).filter((f) => f.length === 2 && f[1] === "true").map((f) => f[0]);
}

// portForward exposes one pod on localhost (pods aren't reachable from the
// host directly) and resolves once kubectl reports the tunnel is up.
export function portForward(pod, localPort) {
  return new Promise((resolve, reject) => {
    const child = spawn("kubectl", ["-n", NS, "port-forward", `pod/${pod}`, `${localPort}:8080`], { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`port-forward to ${pod} timed out`)); }, 15000);
    child.stdout.on("data", (d) => {
      if (String(d).includes("Forwarding from")) { clearTimeout(timer); resolve({ url: `http://localhost:${localPort}`, pod, close: () => child.kill() }); }
    });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`port-forward to ${pod} exited (${code})`)); });
  });
}

// settleHpa waits for the HPA to be back at its minimum. A scale-down left over
// from an earlier test's load would otherwise remove a pod mid-test, dropping
// that pod's viewers while the test is counting what they received.
async function settleHpa() {
  const deadline = Date.now() + 240000;
  let announced = false;
  while (Date.now() < deadline) {
    const [current, desired, min] = kubectl("get", "hpa", "api-server", "-o",
      "jsonpath={.status.currentReplicas} {.status.desiredReplicas} {.spec.minReplicas}").trim().split(" ").map(Number);
    if (current === min && desired === min) return;
    if (!announced) { console.log(`==> Waiting for the HPA to settle (${current} api-server pods, minimum ${min})`); announced = true; }
    await sleep(3000);
  }
  console.log("    (HPA did not settle in time, continuing)");
}
if (K8S) await settleHpa();

// compose runs `docker compose -f deploy/docker-compose.yml ...args` without a
// shell, so SQL and JSON arguments need no quoting.
export function compose(...args) {
  return execFileSync("docker", ["compose", "-f", COMPOSE_FILE, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// runCmd runs an override command from an env var (e.g. a kubectl command
// when these tests run against Kubernetes), or the given compose default.
export function runCmd(envOverride, defaultArgs) {
  if (envOverride) return execSync(envOverride, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return compose(...defaultArgs);
}

export function psql(sql) {
  const args = ["psql", "-U", "auction", "-d", "auction", "-tAc", sql];
  return (K8S ? kubectl("exec", "postgres-0", "--", ...args) : compose("exec", "-T", "postgres", ...args)).trim();
}

export function redisCli(...args) {
  return K8S ? kubectl("exec", "redis-0", "--", "redis-cli", ...args) : compose("exec", "-T", "redis", "redis-cli", ...args);
}

// stopService / startService take a backing service ("kafka", "postgres")
// down and bring it back with its data: docker compose stop/start, or on
// Kubernetes scaling its StatefulSet to 0 and back to 1 (the PVC survives).
// Override with STOP_CMD / START_CMD.
export function stopService(name) {
  if (process.env.STOP_CMD) return runCmd(process.env.STOP_CMD);
  if (!K8S) return compose("stop", name);
  kubectl("scale", "statefulset", name, "--replicas=0");
  try { kubectl("wait", "--for=delete", `pod/${name}-0`, "--timeout=90s"); } catch { /* already gone */ }
}
export function startService(name) {
  if (process.env.START_CMD) return runCmd(process.env.START_CMD);
  if (!K8S) return compose("start", name);
  kubectl("scale", "statefulset", name, "--replicas=1");
}

// crashService kills a backing service's process with SIGKILL - no shutdown
// handler runs, nothing is flushed - and lets it come back on the same data
// (compose: kill + start; Kubernetes: kill the container from Docker, then the
// kubelet restarts it in the same pod on the same PVC). `kubectl delete pod`
// can't do this: the kubelet sends SIGTERM first, which Redis handles by
// saving cleanly. Returns the exit code of the killed process (137 = SIGKILL).
// Override with CRASH_CMD.
export function crashService(name) {
  if (process.env.CRASH_CMD) { runCmd(process.env.CRASH_CMD); return null; }
  if (!K8S) {
    compose("kill", "-s", "SIGKILL", name);
    const id = compose("ps", "-a", "-q", name).trim();
    const code = Number(execFileSync("docker", ["inspect", "-f", "{{.State.ExitCode}}", id], { encoding: "utf8" }).trim());
    compose("start", name);
    return code;
  }
  // Docker Desktop's Kubernetes runs pod containers in its Docker engine.
  const container = execFileSync("docker", ["ps", "-q", "--filter", `name=k8s_${name}_${name}-0_${NS}_`], { encoding: "utf8" }).trim().split("\n")[0];
  if (!container) throw new Error(`no running Docker container for ${name}-0 (only Docker Desktop's Kubernetes is supported; set CRASH_CMD)`);
  execFileSync("docker", ["kill", "-s", "KILL", container], { stdio: "ignore" });
  return Number(execFileSync("docker", ["inspect", "-f", "{{.State.ExitCode}}", container], { encoding: "utf8" }).trim());
}

// stopWorker / startWorker take bid-worker down and bring it back: a Deployment
// on Kubernetes, unlike the StatefulSets above.
export function stopWorker() {
  if (!K8S) return compose("stop", "bid-worker");
  kubectl("scale", "deployment", "bid-worker", "--replicas=0");
  try { kubectl("wait", "--for=delete", "pod", "-l", "app=bid-worker", "--timeout=60s"); } catch { /* already gone */ }
}
export function startWorker() {
  if (!K8S) return compose("start", "bid-worker");
  kubectl("scale", "deployment", "bid-worker", "--replicas=1");
}

// kafkaLag is how many bid-requests messages bid-worker has not committed
// yet, summed over partitions (the LAG column of kafka-consumer-groups.sh).
export function kafkaLag(group = "bid-worker") {
  const args = ["/opt/kafka/bin/kafka-consumer-groups.sh", "--bootstrap-server", "localhost:9092", "--describe", "--group", group];
  const out = K8S ? kubectl("exec", "kafka-0", "--", ...args) : compose("exec", "-T", "kafka", ...args);
  return out.split("\n").filter((l) => l.includes("bid-requests"))
    .reduce((sum, l) => sum + (Number(l.trim().split(/\s+/)[5]) || 0), 0);
}

// bidAndWait sends one bid and waits for its outcome, the way a user clicks
// and watches the result: the bidder's own price_update at that amount
// (accepted) or a bid_rejected for that amount (with its reason). "none"
// means no answer within timeoutMs - a silently lost bid.
export async function bidAndWait(bidder, amount, timeoutMs = 20000) {
  const from = bidder.events.length;
  const sentAt = Date.now();
  bidder.bid(amount);
  let res;
  await waitFor(() => {
    const e = bidder.events.slice(from).find((e) => (e.type === "price_update" || e.type === "bid_rejected") && (e.price ?? e.amount) === amount);
    if (e) res = { amount, sentAt, at: e.at, outcome: e.type === "price_update" ? "accepted" : "rejected", reason: e.reason || "" };
    return !!e;
  }, timeoutMs, `outcome of bid ${amount}`).catch(() => {});
  return res || { amount, sentAt, at: Date.now(), outcome: "none", reason: "" };
}

// dbBids is what Postgres holds for an item: accepted amounts in order, row
// count, and rows that share a request_id (must be 0 - replays are no-ops).
export function dbBids(itemId) {
  const [accepted, rows, dups] = psql(`SELECT coalesce(string_agg(amount::text, ',' ORDER BY amount) FILTER (WHERE status='accepted'), ''),
    count(*), count(*) - count(DISTINCT request_id) FROM bids WHERE item_id='${itemId}'`).split("|");
  return { accepted: accepted ? accepted.split(",").map(Number) : [], rows: Number(rows), dups: Number(dups) };
}

export async function api(base, method, p, body, token) {
  const res = await fetch(`${base}/api${p}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${text}`);
  return data;
}

// register creates a throwaway account; every test deletes its accounts in cleanup().
export async function register(base, tag, displayName) {
  const email = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@chaos.local`;
  const r = await api(base, "POST", "/auth/register", { email, password: "password123", display_name: displayName });
  return { token: r.token, id: r.user.id, name: displayName };
}

// createLiveItem creates an item starting now and waits for bid-worker's
// lifecycle tick to flip it to "live" (only then does a WS connect get a sync).
export async function createLiveItem(base, token, title, { startingPrice = 100, increment = 10, minutes = 10 } = {}) {
  const item = await api(base, "POST", "/items", {
    title, description: "", image_url: "", starting_price: startingPrice, bid_increment: increment,
    start_time: new Date().toISOString(), end_time: new Date(Date.now() + minutes * 60000).toISOString(),
  }, token);
  await waitFor(async () => (await api(base, "GET", `/items/${item.id}`)).status === "live", 15000, "item to go live");
  return item;
}

export async function waitFor(pred, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await sleep(100);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

// Viewer is one WS connection to an auction room that records every event
// with its arrival time. With reconnect: true it mirrors the frontend's
// useAuctionSocket: on close, retry after 1s, doubling up to 10s.
export class Viewer {
  constructor(name, base, itemId, { token = "", reconnect = false } = {}) {
    Object.assign(this, { name, base, itemId, token, reconnect });
    this.events = [];
    this.closes = 0;
    this.connects = 0;
    this.stopped = false;
    this.retryDelay = 1000;
  }

  open() {
    return new Promise((resolve, reject) => {
      const url = `${this.base.replace(/^http/, "ws")}/ws/auctions/${this.itemId}?token=${encodeURIComponent(this.token)}`;
      const ws = new WebSocket(url);
      this.ws = ws;
      let opened = false;
      ws.onopen = () => { opened = true; this.connects++; this.retryDelay = 1000; resolve(); };
      ws.onmessage = (e) => this.events.push({ at: Date.now(), conn: this.connects, ...JSON.parse(e.data) });
      ws.onerror = () => { if (!opened) reject(new Error(`${this.name}: connect failed`)); };
      ws.onclose = () => {
        if (opened) this.closes++;
        if (this.stopped || !this.reconnect) return;
        const delay = this.retryDelay;
        this.retryDelay = Math.min(this.retryDelay * 2, 10000);
        setTimeout(() => this.open().catch(() => {}), delay);
      };
    });
  }

  bid(amount) { this.ws.send(JSON.stringify({ type: "bid", amount })); }
  got(type, pred = () => true) { return this.events.find((e) => e.type === type && pred(e)); }
  close() { this.stopped = true; this.ws?.close(); }
}

const results = [];
export function check(ok, msg) {
  results.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${msg}`);
  return ok;
}
export function allPassed() { return results.length > 0 && results.every(Boolean); }

export function percentile(values, p) {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

// cleanup deletes everything a test created, in foreign-key order. It first
// waits until bid-worker has flushed all expectedBids rows for the item:
// deleting the item while a batch is still in flight would make bid-worker drop
// those rows (see TC-14), and their bid.dropped audit entries would be left
// behind.
export async function cleanup({ itemId, userIds = [], expectedBids = 0 }) {
  if (itemId && expectedBids > 0) {
    await waitFor(() => Number(psql(`SELECT count(*) FROM bids WHERE item_id='${itemId}'`)) >= expectedBids, 15000, "bid rows to be flushed")
      .catch((e) => console.log(`  (cleanup: ${e.message})`));
  }
  await sleep(1000); // fire-and-forget audit_log inserts
  const users = userIds.map((u) => `'${u}'`).join(",") || "NULL";
  const item = itemId ? `'${itemId}'` : "NULL";
  psql(`BEGIN;
    DELETE FROM audit_log WHERE entity_id = ${item}::text OR user_id IN (${users}) OR entity_id IN (SELECT id::text FROM users WHERE id IN (${users}));
    DELETE FROM bids WHERE item_id = ${item} OR user_id IN (${users});
    DELETE FROM items WHERE id = ${item};
    DELETE FROM users WHERE id IN (${users});
    COMMIT;`);
  if (itemId) redisCli("DEL", `item:${itemId}:state`, `item:${itemId}:applied`);
}
