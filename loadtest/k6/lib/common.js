import http from "k6/http";
import { check } from "k6";

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
