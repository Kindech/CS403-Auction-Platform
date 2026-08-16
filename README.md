# Real-time Auction Bidding System

A working implementation of the architecture described in *CS303_Report_68-2_20_ssr-s2.pdf*
("ระบบเสนอราคาประมูลแบบเรียลไทม์" / Real-time Auction Bidding System): a
decoupled, event-sequenced auction platform designed to survive last-second
"bid sniping" traffic spikes without the database becoming a bottleneck.

## Architecture

```
                     ┌─────────────┐
   Browser ── HTTP/WS│    NGINX    │  reverse proxy + load balancer, WS upgrade
                     └──────┬──────┘
                 ┌──────────┴──────────┐
            ┌────▼────┐          ┌────▼────┐
            │ api-1   │          │ api-2   │   Go: REST API + WS gateway,
            │ (Go)    │          │ (Go)    │   JWT auth, per-connection throttle,
            └───┬─────┘          └────┬────┘   forwards raw bids straight to Kafka
                │  produce             │  produce
                └──────────┬───────────┘
                    ┌──────▼───────┐
                    │  Kafka       │  message broker
                    │              │  topic "bid-requests", key = item_id
                    └──────┬───────┘  (guarantees strict per-item ordering)
                    ┌──────▼───────┐
                    │  bid-worker  │  Go: single sequential consumer loop
                    │              │  → read/compare/write item state in Redis
                    │              │  → anti-snipe (soft-close) extension
                    │              │  → direct HTTP notify to every api-* instance
                    │              │  → async batched INSERT into Postgres
                    │              │  → commits the Kafka offset only after that
                    │              │    insert succeeds (at-least-once, replayable)
                    └───┬──────┬───┘
                  ┌─────▼─┐  ┌─▼──────────┐
                  │ Redis │  │ PostgreSQL │
                  │(state)│  │(audit log, │
                  │       │  │ users,     │
                  │       │  │ items)     │
                  └───────┘  └────────────┘
```

**Why this is race-free without locks**: Kafka partitions the `bid-requests`
topic by `item_id`, so every bid for the same item lands on the same
partition, in arrival order. `bid-worker` runs one sequential consumer loop,
so at any instant only one goroutine is ever reading/writing a given item's
Redis state - there is no concurrent access to serialize against, so no
distributed lock is needed (report §3.3.2).

**Why a worker crash can't lose data**: the Kafka offset for a bid is only
committed *after* its audit record is durably written to Postgres. If
`bid-worker` dies mid-batch, those messages are simply re-delivered to
whichever instance replaces it (report §2.6.4). See `loadtest/chaos/tc06_worker_crash_replay.sh`.

## Repo layout

```
backend/            Go module: cmd/api-server, cmd/bid-worker, internal/*
  migrations/        Postgres schema + demo seed data
frontend/            React + Vite + TypeScript + Tailwind SPA
deploy/              docker-compose.yml, Dockerfiles, nginx.conf
loadtest/            k6 + chaos scripts implementing the report's test plan
```

## Running it

Requires Docker Desktop.

```bash
cd deploy
docker compose up -d --build
```

This starts Postgres, Kafka, Redis, two `api-server` replicas, one
`bid-worker`, and an nginx container that serves the built frontend and
proxies `/api` and `/ws` to the `api-*` replicas.

Open **http://localhost:8080**.

Demo accounts (seeded by `backend/migrations/0001_init.sql`), password for
both is `password123`:

| Email | Role |
|---|---|
| `seller@example.com` | has two demo listings (one live, one upcoming) |
| `bidder@example.com` | plain bidder account |

Or register your own account from the UI.

Direct service ports, if you want to bypass nginx while debugging:

| Service | Host port |
|---|---|
| nginx (frontend + API/WS proxy) | 8080 |
| api-1 | 8081 |
| api-2 | 8082 |
| PostgreSQL | 5432 (`auction`/`auction`, db `auction`) |
| Redis | 6379 |
| Kafka | 9092 |

Stop everything with `docker compose down` (add `-v` to also drop the
Postgres volume and start from a clean seed next time).

## Backend development

```bash
cd backend
go test ./...           # unit tests for internal/decision (no services needed)
go build ./...
```

`internal/decision` holds the pure bid-adjudication function (accept/reject,
anti-snipe boundary, equal-bid races) with no I/O, so its tests run instantly
and cover the correctness properties the whole architecture depends on.

Key environment variables (see `internal/config/config.go` for the full
list and defaults, and `deploy/docker-compose.yml` for how they're wired):

| Var | Meaning |
|---|---|
| `POSTGRES_URL`, `REDIS_ADDR`, `KAFKA_BROKERS` | service endpoints |
| `JWT_SECRET`, `INTERNAL_SECRET` | must match across every `api-*` and `bid-worker` instance |
| `PEER_INTERNAL_URLS` | (bid-worker only) every `api-*` instance's internal base URL, for direct broadcast |
| `BID_RATE_LIMIT_PER_SEC` | per-WS-connection bid throttle (report NFR: 10/s) |
| `ANTI_SNIPE_WINDOW` / `ANTI_SNIPE_EXTENSION` | soft-close window and extension length |

## Frontend development

```bash
cd frontend
npm install
npm run dev   # proxies /api and /ws to http://localhost:8080 - run at least api-1 locally, or point at the compose stack's nginx
```

Pages implement every screen from report §3.6: register/login, dashboard
(live/upcoming/ended listings with countdowns), the live auction room
(bidding console + live bid history over WebSocket), winner announcement,
seller tools (create + track listings), and personal bid history.

## Load & correctness testing

`loadtest/` implements the report's test plan (TC-01..TC-04) plus three
tests added to cover claims made elsewhere in the report that the table
didn't have a scenario for (soft-close extension, worker crash/replay,
reconnect resync). See `loadtest/README.md` for details on each one and how
to read the results.

```bash
cd loadtest
k6 run k6/tc02_race_condition_duel.js   # fast correctness check, good first run
./run_all.sh                            # everything, in report order
```

**Known environment caveat** (and this is literally what report §3.5.1 warns
about): running k6 with more than ~200-300 virtual users *from the Windows
host* against a `docker compose`-published port can hit Docker Desktop's
host↔container port-forwarding capacity before the actual system's limit is
reached, showing failed WS handshakes that have nothing to do with the
application. Confirmed fix used during development: run k6 itself inside the
compose network so traffic never crosses the host networking layer:

```bash
docker run --rm --network deploy_default \
  -v "$(pwd)/loadtest:/scripts" -w /scripts \
  -e BASE_URL=http://nginx \
  grafana/k6 run k6/tc01_fanout_broadcast.js
```

All of TC-01 (500 VUs), TC-03 (2000 VUs), and TC-04 (1000 VUs) were verified
passing this way.

A related symptom of the same root cause: after running heavy load tests
directly against `localhost:8080` on Windows, new WebSocket connections
through that same host port can start hanging entirely (plain HTTP keeps
working fine) because Docker Desktop's host↔container port-forwarding layer
accumulates stale connection state. If that happens, `docker compose restart
nginx api-1 api-2` clears it immediately - this was reproduced and confirmed
during development, it is not an application-level bug.

## What's intentionally out of scope

Per the confirmed implementation scope, this is a Docker Compose deployment,
not a live Kubernetes cluster - `api-1`/`api-2` stand in for what would be an
HPA-scaled Deployment, and nginx's static upstream list stands in for what
would be a K8s Service/Ingress. The architecture (stateless API servers,
single-sequential-consumer worker, direct broadcast, offset-commit-after-write)
is identical either way; only the elasticity mechanism differs.
