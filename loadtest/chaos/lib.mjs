// Shared helpers for the Node-based chaos/scale tests (TC-08, TC-09).
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

function redisCli(...args) {
  return K8S ? kubectl("exec", "redis-0", "--", "redis-cli", ...args) : compose("exec", "-T", "redis", "redis-cli", ...args);
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
// deleting the item while a batch is still in flight would make that batch's
// INSERT fail on the foreign key, and bid-worker retries a failed batch
// until it succeeds - stalling every later write.
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
