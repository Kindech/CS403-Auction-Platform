#!/usr/bin/env bash
# TC-06 Worker Crash + Replay (added - validates report section 2.6.4's
# "at-least-once processing" claim: bid-worker only commits a Kafka offset
# after its Postgres batch write succeeds, so killing it mid-flight must
# never lose an audit record - the replacement instance replays whatever
# was still uncommitted).
#
# Usage: ./tc06_worker_crash_replay.sh
# Requires: the compose stack already running (see ../../deploy), curl, node.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../deploy" && pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

json_get() {
  # json_get '<json>' 'path.to.field'
  node -e "const d=JSON.parse(process.argv[1]); console.log(process.argv[2].split('.').reduce((o,k)=>o[k],d))" "$1" "$2"
}

echo "==> Logging in as demo seller/bidder"
SELLER_LOGIN=$(curl -s -X POST "$BASE_URL/api/auth/login" -H "Content-Type: application/json" \
  -d '{"email":"seller@example.com","password":"password123"}')
BIDDER_LOGIN=$(curl -s -X POST "$BASE_URL/api/auth/login" -H "Content-Type: application/json" \
  -d '{"email":"bidder@example.com","password":"password123"}')
SELLER_TOKEN=$(json_get "$SELLER_LOGIN" token)
BIDDER_TOKEN=$(json_get "$BIDDER_LOGIN" token)

echo "==> Creating a fresh test item"
NOW=$(node -e "console.log(new Date().toISOString())")
END=$(node -e "console.log(new Date(Date.now()+10*60*1000).toISOString())")
ITEM=$(curl -s -X POST "$BASE_URL/api/items" -H "Content-Type: application/json" -H "Authorization: Bearer $SELLER_TOKEN" \
  -d "{\"title\":\"TC-06 Chaos Test Item\",\"description\":\"\",\"image_url\":\"\",\"starting_price\":100,\"bid_increment\":1,\"start_time\":\"$NOW\",\"end_time\":\"$END\"}")
ITEM_ID=$(json_get "$ITEM" id)
echo "    item id: $ITEM_ID"

echo "==> Sending 10 baseline bids (worker healthy)"
node "$SCRIPT_DIR/send_bids.js" "$BIDDER_TOKEN" "$ITEM_ID" 10 1000
sleep 2

BASELINE_COUNT=$(curl -s "$BASE_URL/api/items/$ITEM_ID/bids" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).length))")
echo "    audit log rows after baseline: $BASELINE_COUNT (expected 10)"
if [ "$BASELINE_COUNT" -ne 10 ]; then
  echo "FAIL: baseline bids were not all recorded before the crash - aborting"
  exit 1
fi

echo "==> Firing 20 more bids and killing bid-worker mid-flight"
node "$SCRIPT_DIR/send_bids.js" "$BIDDER_TOKEN" "$ITEM_ID" 20 2000 &
SEND_PID=$!
sleep 0.1
(cd "$DEPLOY_DIR" && docker compose kill -s SIGKILL bid-worker) || true
wait "$SEND_PID" || true

echo "==> Restarting bid-worker (simulates Kubernetes self-healing / pod replacement)"
(cd "$DEPLOY_DIR" && docker compose start bid-worker)

echo "==> Polling audit log until it stabilizes at 30 rows (replay may take a few seconds)"
EXPECTED=30
for i in $(seq 1 30); do
  COUNT=$(curl -s "$BASE_URL/api/items/$ITEM_ID/bids" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).length))")
  echo "    [$i/30] current audit row count: $COUNT"
  if [ "$COUNT" -eq "$EXPECTED" ]; then
    echo "PASS: all $EXPECTED bids were durably recorded despite the mid-flight worker crash (zero data loss)"
    exit 0
  fi
  sleep 1
done

echo "FAIL: audit log settled at $COUNT rows, expected $EXPECTED - a message was lost after the crash"
exit 1
