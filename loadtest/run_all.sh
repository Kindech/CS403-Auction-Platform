#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

echo "### TC-01 Fan-out Broadcast"
k6 run k6/tc01_fanout_broadcast.js

echo "### TC-02 Race Condition (The Duel)"
k6 run k6/tc02_race_condition_duel.js

echo "### TC-03 Stress Test & Throttling"
k6 run k6/tc03_stress_throttling.js

echo "### TC-04 Bid Sniping"
k6 run k6/tc04_bid_sniping.js

echo "### TC-05 Soft-Close / Anti-Sniping Extension (~90s)"
k6 run k6/tc05_soft_close_extension.js

echo "### TC-07 Reconnect Resync"
k6 run k6/tc07_reconnect_resync.js

echo "### TC-06 Worker Crash + Replay"
bash chaos/tc06_worker_crash_replay.sh

echo "### TC-08 Scale-out Fan-out"
node chaos/tc08_scaleout_fanout.mjs

echo "### TC-09 API Server Failover"
node chaos/tc09_api_failover.mjs

echo "### TC-10 Kafka Restart"
node chaos/tc10_kafka_restart.mjs

echo "### TC-11 Postgres Outage"
node chaos/tc11_postgres_outage.mjs

echo "### TC-12 Redis Outage"
node chaos/tc12_redis_outage.mjs

echo "### TC-13 Auction Closing With a Backlog"
node chaos/tc13_close_with_backlog.mjs

echo "### TC-14 Item Deleted Mid-Auction"
node chaos/tc14_deleted_item.mjs

echo "### TC-15 Redis Crash"
node chaos/tc15_redis_crash.mjs

# TC-16 needs the 3-broker Kafka of k8s/ (compose runs one broker).
if [ "${TARGET:-}" = "k8s" ]; then
  echo "### TC-16 Kafka Broker Failover"
  node chaos/tc16_kafka_broker_failover.mjs
fi

echo "All load/chaos tests passed."
