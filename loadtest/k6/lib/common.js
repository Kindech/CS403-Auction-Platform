import http from "k6/http";
import { check, sleep } from "k6";

export const BASE_URL = __ENV.BASE_URL || "http://localhost:8080";
export const WS_BASE = BASE_URL.replace(/^http/, "ws");

const JSON_HEADERS = { "Content-Type": "application/json" };

export function register(emailLocal, password, displayName) {
  const email = `${emailLocal}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@loadtest.local`;
  const res = http.post(
    `${BASE_URL}/api/auth/register`,
    JSON.stringify({ email, password, display_name: displayName }),
    { headers: JSON_HEADERS }
  );
  check(res, { "register: 201": (r) => r.status === 201 });
  const body = JSON.parse(res.body);
  return { token: body.token, userId: body.user.id, email };
}

export function login(email, password) {
  const res = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({ email, password }),
    { headers: JSON_HEADERS }
  );
  check(res, { "login: 200": (r) => r.status === 200 });
  const body = JSON.parse(res.body);
  return { token: body.token, userId: body.user.id };
}

export function createItem(token, opts) {
  const res = http.post(`${BASE_URL}/api/items`, JSON.stringify(opts), {
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
  });
  check(res, { "create item: 201": (r) => r.status === 201 });
  return JSON.parse(res.body);
}

export function getBids(itemId) {
  const res = http.get(`${BASE_URL}/api/items/${itemId}/bids`);
  return JSON.parse(res.body);
}

export function getItem(itemId) {
  const res = http.get(`${BASE_URL}/api/items/${itemId}`);
  return JSON.parse(res.body);
}

export function wsUrlFor(itemId, token) {
  return `${WS_BASE}/ws/auctions/${itemId}?token=${encodeURIComponent(token)}`;
}

// registerUsers creates `count` bidders through the real register endpoint,
// 50 requests in flight at a time, and returns their tokens (index i is
// "<label> <i+1>"). Load tests use one account per connection, as real users
// would: a rejected bid goes to every connection of its bidder, so one shared
// account turns each rejection into a message per connection.
export function registerUsers(count, label) {
  const run = `${Date.now()}`;
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const tokens = [];
  for (let start = 0; start < count; start += 50) {
    const batch = [];
    for (let i = start; i < Math.min(start + 50, count); i++) {
      batch.push({
        method: "POST",
        url: `${BASE_URL}/api/auth/register`,
        body: JSON.stringify({
          email: `${slug}-${run}-${i}@loadtest.local`,
          password: "password123",
          display_name: `${label} ${i + 1}`,
        }),
        params: { headers: JSON_HEADERS, tags: { name: "register" } },
      });
    }
    for (const res of http.batch(batch)) {
      check(res, { "register: 201": (r) => r.status === 201 });
      tokens.push(res.status === 201 ? JSON.parse(res.body).token : "");
    }
  }
  console.log(`registered ${tokens.filter((t) => t).length}/${count} ${label} accounts`);
  return tokens;
}

const PROM_URL = __ENV.PROM_URL ?? "http://prometheus:9090";

function promQuery(q) {
  const res = http.get(`${PROM_URL}/api/v1/query?query=${encodeURIComponent(q)}`, { tags: { name: "prometheus" } });
  if (res.status !== 200) return null;
  const r = JSON.parse(res.body).data.result;
  return r.length ? Number(r[0].value[1]) : 0;
}

// waitForBaseline waits (via the in-cluster Prometheus) until api-server is
// back at its minimum pod count and idle. Registering hundreds of users costs
// a bcrypt hash each, enough CPU for the HPA to add pods; waiting means the
// measured part of every run starts from the same 2 pods. Skipped when
// Prometheus isn't reachable (e.g. against compose; PROM_URL="" disables it).
export function waitForBaseline(minPods = Number(__ENV.MIN_PODS || 2)) {
  if (!PROM_URL || promQuery("vector(1)") === null) {
    console.log("Prometheus not reachable - not waiting for the HPA to settle");
    return;
  }
  const started = Date.now();
  for (;;) {
    const pods = promQuery('count(up{job="api-server"} == 1)');
    const cpu = promQuery('avg(rate(process_cpu_seconds_total{job="api-server"}[30s])) / 0.1 * 100');
    if (pods <= minPods && cpu < 20) {
      console.log(`api-server back at ${pods} pods, CPU ${cpu.toFixed(0)}% - starting the test`);
      return;
    }
    if (Date.now() - started > 8 * 60 * 1000) {
      console.log(`HPA still at ${pods} pods after 8 minutes - starting anyway`);
      return;
    }
    console.log(`waiting for api-server to settle: ${pods} pods, CPU ${cpu.toFixed(0)}%`);
    sleep(10);
  }
}

// A short-lived item is all these tests need; none of them depend on the
// demo seed data, so every script can run repeatedly against a fresh stack.
export function freshItem(sellerToken, opts) {
  const now = new Date();
  return createItem(sellerToken, {
    title: opts.title,
    description: opts.description || "load-test item, safe to ignore",
    image_url: "",
    starting_price: opts.startingPrice ?? 100,
    bid_increment: opts.bidIncrement ?? 10,
    start_time: now.toISOString(),
    end_time: new Date(now.getTime() + (opts.durationSec ?? 300) * 1000).toISOString(),
  });
}
