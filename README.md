# Real-time Auction Bidding System

[![CI](https://github.com/Kindech/CS403-Auction-Platform/actions/workflows/ci.yml/badge.svg)](https://github.com/Kindech/CS403-Auction-Platform/actions/workflows/ci.yml)

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

**Anyone can watch, only accounts can bid**: report §3.2.1 only requires an
account to place a bid, not to see prices update live. The WS handshake
never requires a token - a missing/invalid one just connects as an
anonymous viewer, who still gets every `sync`/`price_update` push in real
time but has any `bid` message rejected with `not_authenticated`.

**Names are masked, eBay-style**: every bidder/winner name reaching an API
response or WS push is `models.MaskDisplayName`'d (`"Beer"` → `"B***r"`)
for anyone except that name's owner - live price updates, bid history, item
listings, and the winner announcement all go through it. The database
itself is untouched; masking happens only in the response-serialization
layer, per request/per recipient.

## Repo layout

```
backend/            Go module: cmd/api-server, cmd/bid-worker, internal/*
  migrations/        Postgres schema + demo seed data
frontend/            React + Vite + TypeScript + Tailwind SPA
deploy/              docker-compose.yml, Dockerfiles, nginx.conf
loadtest/            k6 + chaos scripts implementing the report's test plan
.github/workflows/   CI: go vet/build/test + frontend build, on every push
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
| Prometheus | 9090 |
| Grafana | 3000 |
| bid-worker metrics | 9101 |

Stop everything with `docker compose down` (add `-v` to also drop the
Postgres volume and start from a clean seed next time).

## Observability (Prometheus + Grafana)

Both `api-server` and `bid-worker` expose Prometheus metrics on `/metrics`
(`internal/metrics` defines them; `promauto` registers everything against
the default registry, so any binary that imports the package just needs to
serve `promhttp.Handler()`). Prometheus scrapes `api-1`, `api-2`, and
`bid-worker` every 5s (`deploy/prometheus/prometheus.yml`); Grafana comes
pre-provisioned with a datasource and two dashboards - no manual setup
needed, unlike pgAdmin above.

Open **http://localhost:3000** and log in:

| Field | Value |
|---|---|
| Username | `admin` (override with `GRAFANA_USER`) |
| Password | `admin` (override with `GRAFANA_PASSWORD`) |

| Dashboard | Shows |
|---|---|
| **Auction - Application Overview** | Live WS connections, bid accept/reject rate and reject reasons, items finalized (sold/unsold), HTTP request rate and p95 latency by route, and `bid-worker`'s adjudication latency (p50/p95/p99) - the number the report's fast-path NFRs are actually about |
| **Auction - k6 Load Test** | VUs, HTTP request rate, p99 duration, failure rate, check pass rate, and WebSocket session/connect-time stats - populated whenever a k6 run pushes to Prometheus (see `loadtest/README.md`'s Grafana section) |

Metric names worth knowing if you want to write your own queries in
Prometheus (`http://localhost:9090`) or Grafana's Explore view:

| Metric | Type | Meaning |
|---|---|---|
| `auction_ws_connections_active` | gauge | currently-open WS connections, this instance |
| `auction_bids_total{status,reason}` | counter | every adjudication outcome |
| `auction_bid_processing_duration_seconds` | histogram | `handleBid` latency: Redis read through notify |
| `auction_items_finalized_total{outcome}` | counter | auctions closed, `sold`/`unsold` |
| `auction_http_requests_total{route,method,status}` | counter | REST requests, by matched chi route pattern |
| `auction_http_request_duration_seconds{route,method}` | histogram | REST latency |

Verified during development: generated real bids through the API and
confirmed the exact PromQL each panel uses returns correct values directly
against Prometheus's HTTP API before trusting the dashboard - e.g. bid
processing p99 came back at 0.78ms, consistent with the architecture's
"no disk I/O in the fast path" design.

## Managing the database (pgAdmin)

The stack is PostgreSQL, not Microsoft SQL Server, so SQL Server Management
Studio can't connect to it directly. Instead, `deploy/docker-compose.yml`
includes a **pgAdmin** container - a browser-based GUI (tables, query editor,
row editing) that plays the same role as SSMS, pointed at the `postgres`
container.

```bash
cd deploy
docker compose up -d postgres pgadmin
```

Open **http://localhost:5050** and log in:

| Field | Value |
|---|---|
| Email | `admin@auction.com` (override with `PGADMIN_EMAIL`) |
| Password | `admin` (override with `PGADMIN_PASSWORD`) |

First time only, register a server (right-click **Servers** → Register →
Server):

| Field | Value |
|---|---|
| Name | anything, e.g. `auction` |
| Host name/address | `postgres` |
| Port | `5432` |
| Maintenance database | `auction` |
| Username | `auction` |
| Password | `auction` |

pgAdmin remembers this connection (stored in the `pgadmin-data` volume), so
you won't need to re-register it on future `docker compose up`s. Once
connected, expand `auction → Databases → auction → Schemas → public →
Tables` to browse `users`, `items`, `bids`, and `audit_log`.

`audit_log` (`backend/migrations/0002_audit_log.sql`) is a single
chronological timeline across the whole account/auction lifecycle -
`user.register`, `user.login`, `user.login_failed`, `user.login_locked`
(see the lockout note below), `item.create`, `bid.accepted`,
`bid.rejected` (with the reason in `details`), and `item.ended` (winner
and final price, or `"no bids"`). `bids` stays the per-item audit trail
the report itself requires (§3.2.1); `audit_log` is the broader one.

Migrations only auto-run against a brand-new Postgres volume
(`docker-entrypoint-initdb.d` only fires on first init). If you're
updating an existing stack rather than starting fresh, apply new
migration files by hand instead of losing data with `docker compose down
-v`:

```bash
docker compose exec -T postgres psql -U auction -d auction -f - < ../backend/migrations/0003_login_lockout.sql
```

## Backend development

```bash
cd backend
go vet ./...
go build ./...
go test ./... -v         # internal/decision + internal/models, no services needed
```

`internal/decision` holds the pure bid-adjudication function (accept/reject,
anti-snipe boundary, equal-bid races) and `internal/models` holds
`MaskDisplayName` - both have no I/O, so their tests run instantly and cover
the correctness properties the rest of the app depends on.

Key environment variables (see `internal/config/config.go` for the full
list and defaults, and `deploy/docker-compose.yml` for how they're wired):

| Var | Meaning |
|---|---|
| `POSTGRES_URL`, `REDIS_ADDR`, `KAFKA_BROKERS` | service endpoints |
| `JWT_SECRET`, `INTERNAL_SECRET` | must match across every `api-*` and `bid-worker` instance |
| `PEER_INTERNAL_URLS` | (bid-worker only) every `api-*` instance's internal base URL, for direct broadcast |
| `BID_RATE_LIMIT_PER_SEC` | per-WS-connection bid throttle (report NFR: 10/s) |
| `ANTI_SNIPE_WINDOW` / `ANTI_SNIPE_EXTENSION` | soft-close window and extension length |

Login lockout (`maxFailedLoginAttempts` / `loginLockoutDuration` in
`internal/httpapi/auth_handlers.go`, not env-configurable) locks an account
for 15 minutes after 5 wrong passwords in a row - the correct password is
rejected too while locked, without even being checked, so a lockout can't
be extended by guessing. `RegisterFailedLogin` does the increment-and-maybe-
lock atomically in one `UPDATE`, so concurrent attempts can't race past the
threshold.

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

The live auction room shows two distinct popups over WebSocket events: a red
one for your own rejected bids (too low, auction closed, rate-limited, not
logged in), and a separate blue one when someone else overtakes the price
you were leading at (`outbid` event, targeted only at the previous leader -
everyone else just sees the normal price update).

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

## Continuous Integration

`.github/workflows/ci.yml` runs on every push/PR to any branch, two jobs in
parallel:

| Job | Steps |
|---|---|
| Backend | `go vet ./...` → `go build ./...` → `go test ./... -v` |
| Frontend | `npm ci` → `npm run build` (`tsc -b` type-checks, then `vite build`) |

No live services required - both jobs run against a clean checkout with
nothing else running, matching how `internal/decision`/`internal/models`
and the frontend build are meant to be verified. Check the **Actions** tab
on GitHub for run history; the badge at the top of this file reflects the
latest run on whichever branch GitHub picks by default.

## What's intentionally out of scope

Per the confirmed implementation scope, this is a Docker Compose deployment,
not a live Kubernetes cluster - `api-1`/`api-2` stand in for what would be an
HPA-scaled Deployment, and nginx's static upstream list stands in for what
would be a K8s Service/Ingress. The architecture (stateless API servers,
single-sequential-consumer worker, direct broadcast, offset-commit-after-write)
is identical either way; only the elasticity mechanism differs.
