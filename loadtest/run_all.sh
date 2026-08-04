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

echo "All load/chaos tests passed."
