// Fires `count` bids over a single WS connection, paced under the server's
// per-connection throttle (BID_RATE_LIMIT_PER_SEC, default 10/s - see
// internal/ws/handler.go) so every message is actually accepted for
// adjudication instead of being rejected at the ingestion gate. Used by
// tc06_worker_crash_replay.sh to generate in-flight traffic right as
// bid-worker gets killed.
//
// Usage: node send_bids.js <token> <itemId> <count> <startAmount> [ratePerSec]
const token = process.argv[2];
const itemId = process.argv[3];
const count = Number(process.argv[4]);
const startAmount = Number(process.argv[5] || 1000);
const ratePerSec = Number(process.argv[6] || 8); // stay under the default 10/s cap
const baseURL = process.env.BASE_URL || "http://localhost:8080";
const wsBase = baseURL.replace(/^http/, "ws");

const ws = new WebSocket(`${wsBase}/ws/auctions/${itemId}?token=${encodeURIComponent(token)}`);
const intervalMs = Math.ceil(1000 / ratePerSec);

ws.addEventListener("open", () => {
  let sent = 0;
  const timer = setInterval(() => {
    ws.send(JSON.stringify({ type: "bid", amount: startAmount + sent }));
    sent++;
    if (sent >= count) {
      clearInterval(timer);
      console.log(`sent ${sent} bids (paced at ~${ratePerSec}/s)`);
      setTimeout(() => process.exit(0), 500);
    }
  }, intervalMs);
});

ws.addEventListener("error", (e) => {
  console.error("ws error", e.message);
  process.exit(1);
});

setTimeout(() => {
  console.error("timed out waiting for socket to open");
  process.exit(1);
}, 5000);
