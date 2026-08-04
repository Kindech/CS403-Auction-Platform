# Load & chaos tests

These exercise the report's test plan (Table 3.1, TC-01..TC-04) plus three
tests added to cover claims the report makes elsewhere that the original
table didn't include a scenario for:

| ID | Name | Covers | Type |
|----|------|--------|------|
| TC-01 | Fan-out Broadcast | §3.1.1 step 5 - one accepted bid reaches every connected client | k6 |
| TC-02 | Race Condition (The Duel) | §3.3.2 - identical simultaneous bids, exactly one winner | k6 |
| TC-03 | Stress Test & Throttling | §3.2.2 NFRs - 2000 clients, 0% dropped connections, per-conn throttle holds | k6 |
| TC-04 | Bid Sniping / High Concurrency | §2.3 - last-second stampede, single winner, no crash | k6 |
| TC-05 | Soft-Close / Anti-Sniping Extension *(added)* | §3.1.1 step 4 - end_time only extends inside the anti-snipe window | k6 |
| TC-06 | Worker Crash + Replay *(added)* | §2.6.4 - killing bid-worker mid-batch loses zero audit records | bash + node |
| TC-07 | Reconnect Resync *(added)* | §3.6.3 - "no page reload", reconnect always gets fresh state | k6 |

## Prerequisites

- The compose stack running: `cd ../deploy && docker compose up -d --build`
- [k6](https://k6.io/) installed locally (or use `docker run --rm -i grafana/k6 run - <script.js`)
- Node.js (only for `chaos/send_bids.js`)

All scripts default to `BASE_URL=http://localhost:8080` (nginx). Override with
`-e BASE_URL=http://your-host:8080` if needed.

## Running

```bash
# from loadtest/
k6 run k6/tc01_fanout_broadcast.js
k6 run k6/tc02_race_condition_duel.js
k6 run k6/tc03_stress_throttling.js
k6 run k6/tc04_bid_sniping.js
k6 run k6/tc05_soft_close_extension.js   # takes ~90s (real anti-snipe wait)
k6 run k6/tc07_reconnect_resync.js
bash chaos/tc06_worker_crash_replay.sh
```

Or run everything with `./run_all.sh` (stops at the first failure).

Every k6 script creates its own throwaway item (and, where needed, throwaway
users) via the REST API in its `setup()` function, so they're safe to run
repeatedly against a live stack without interfering with each other or with
manual testing through the UI.

## Reading the results

- k6 prints a `checks` summary and each script's `thresholds` block at the
  end; a run that prints not just the summary tables but also an `EXITSTATUS`
  other than 0 (or a red `thresholds` line) means a test failed.
- TC-02/TC-04/TC-05/TC-07 make their real assertions via `check()` inside
  `default`/`teardown` - read the console output around
  `"exactly 1 bid was accepted"` etc. if you need the specific failure.
- TC-06 is a plain bash script; it prints `PASS`/`FAIL` and exits 0/1
  accordingly. It leaves `bid-worker` running again when it finishes either
  way.

## Tuning

- `VUS` env var overrides the virtual-user counts in TC-01/03/04 (defaults:
  500 / 2000 / 1000, matching the report's table).
- `ANTI_SNIPE_WINDOW_SEC` overrides TC-05's assumed window; keep it in sync
  with `ANTI_SNIPE_WINDOW` in `deploy/docker-compose.yml` (default 60s).
