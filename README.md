# Real-time Auction Bidding System

[![CI](https://github.com/Kindech/CS403-Auction-Platform/actions/workflows/ci.yml/badge.svg)](https://github.com/Kindech/CS403-Auction-Platform/actions/workflows/ci.yml)

ระบบที่ใช้งานได้จริงตามสถาปัตยกรรมในรายงาน *CS303_Report_68-2_20_ssr-s2.pdf*
("ระบบเสนอราคาประมูลแบบเรียลไทม์" / Real-time Auction Bidding System) เป็นแพลตฟอร์มประมูลแบบ
decoupled และ event-sequenced ออกแบบมาให้รับ traffic ที่พุ่งขึ้นช่วงวินาทีสุดท้าย ("bid sniping")
ได้ โดยไม่ให้ database กลายเป็นคอขวด

## สถาปัตยกรรม (Architecture)

```
                     ┌─────────────┐
   Browser ── HTTP/WS│    NGINX    │  reverse proxy + load balancer, WS upgrade
                     └──────┬──────┘
                 ┌──────────┴──────────┐
            ┌────▼────┐          ┌────▼────┐
            │ api-1   │          │ api-2   │   Go: REST API + WS gateway,
            │ (Go)    │          │ (Go)    │   JWT auth, throttle ต่อ connection,
            └───┬─────┘          └────┬────┘   ส่งบิดดิบเข้า Kafka ทันที
                │  produce             │  produce
                └──────────┬───────────┘
                    ┌──────▼───────┐
                    │  Kafka       │  message broker
                    │              │  topic "bid-requests", key = item_id
                    └──────┬───────┘  (รับประกันลำดับบิดของแต่ละ item)
                    ┌──────▼───────┐
                    │  bid-worker  │  Go: consumer loop แบบทีละตัว (sequential)
                    │              │  → อ่าน/เทียบ/เขียน state ของ item ใน Redis
                    │              │  → ต่อเวลาเมื่อบิดช่วงท้าย (anti-snipe / soft-close)
                    │              │  → PUBLISH ผลลง Redis Pub/Sub; api-* ทุกตัว
                    │              │    SUBSCRIBE แล้วส่งต่อให้ผู้ใช้ของตัวเอง
                    │              │  → batch INSERT ลง Postgres แบบ async
                    │              │  → commit Kafka offset หลัง insert สำเร็จเท่านั้น
                    │              │    (at-least-once, replay ได้)
                    └───┬──────┬───┘
                  ┌─────▼─┐  ┌─▼──────────┐
                  │ Redis │  │ PostgreSQL │
                  │(state)│  │(audit log, │
                  │       │  │ users,     │
                  │       │  │ items)     │
                  └───────┘  └────────────┘
```

**ทำไมไม่เกิด race condition ทั้งที่ไม่ใช้ lock:** Kafka แบ่ง partition ของ topic `bid-requests`
ตาม `item_id` บิดของ item เดียวกันจึงลง partition เดียวกันตามลำดับที่เข้ามา และ `bid-worker`
ทำงานเป็น consumer loop ทีละตัว ในแต่ละช่วงเวลาจึงมี goroutine เดียวที่อ่าน/เขียน Redis state
ของ item นั้น ไม่มีการเข้าถึงพร้อมกันให้ต้องจัดลำดับ จึงไม่ต้องใช้ distributed lock (รายงาน §3.3.2)

**ทำไม worker ตายแล้วข้อมูลไม่หาย:** Kafka offset ของบิดจะถูก commit *หลังจาก* audit record
เขียนลง Postgres สำเร็จแล้วเท่านั้น ถ้า `bid-worker` ตายกลาง batch ข้อความเหล่านั้นจะถูกส่งซ้ำให้
instance ที่มาแทน (รายงาน §2.6.4) ดู `loadtest/chaos/tc06_worker_crash_replay.sh`

**ทำไมส่งผลการบิดผ่าน Redis Pub/Sub:** WebSocket ของแต่ละเบราว์เซอร์ค้างอยู่กับ api-server
ตัวที่ nginx เลือกให้ บิดที่ผ่านทุกครั้งจึงต้องไปถึง api-server *ทุกตัว* `bid-worker` publish
ผลครั้งเดียวลง channel `auction:events` (`internal/eventbus`) และ api-server ทุกตัว subscribe
ตอนเริ่มทำงาน (`Hub.RelayEvents`) api-server ที่เพิ่มขึ้นมาตอน scale out จึงได้ event โดยไม่ต้อง
แก้ config เลย (แบบเดิมใช้ HTTP POST ไปตามรายชื่อตายตัวใน `PEER_INTERNAL_URLS` ซึ่งตัวใหม่ไม่มีชื่อ
อยู่ในนั้น) การส่งเป็นแบบ at-most-once ซึ่งไม่เป็นปัญหา เพราะ event บอกสถานะเต็ม (ราคาปัจจุบัน
ไม่ใช่ส่วนต่าง) event ถัดไปจึงแก้ตัวที่พลาดได้ และ client ที่ reconnect จะได้ `sync` ใหม่เสมอ
ส่วนผลการตัดสินบิดจริงยังเก็บถาวรใน Kafka/Redis/Postgres — วิธีทดสอบเองดูหัวข้อ
[ทดสอบ Redis Pub/Sub ด้วยตัวเอง](#ทดสอบ-redis-pubsub-ด้วยตัวเอง)

**ใครก็ดูได้ แต่ต้องมีบัญชีถึงจะบิดได้:** รายงาน §3.2.1 กำหนดให้ต้องมีบัญชีเฉพาะตอนบิด ไม่ใช่ตอนดู
ราคาสด WS handshake จึงไม่บังคับ token ถ้าไม่มีหรือ token ผิดจะเชื่อมต่อเป็น anonymous viewer
ซึ่งยังได้ `sync`/`price_update` แบบ real-time ครบ แต่ถ้าส่ง `bid` มาจะถูกปฏิเสธด้วย
`not_authenticated`

**ชื่อถูกปิดบางส่วนแบบ eBay:** ชื่อผู้บิด/ผู้ชนะที่ออกไปทาง API response หรือ WS push จะผ่าน
`models.MaskDisplayName` (`"Beer"` → `"B***r"`) สำหรับทุกคนยกเว้นเจ้าของชื่อ ใช้กับราคาสด
ประวัติบิด รายการสินค้า และประกาศผู้ชนะ ข้อมูลใน database ไม่ถูกแก้ไข การปิดชื่อทำเฉพาะชั้น
serialization ของ response ตาม request/ผู้รับแต่ละคน

## โครงสร้าง repo

```
backend/            Go module: cmd/api-server, cmd/bid-worker, internal/*
  migrations/        Postgres schema + ข้อมูล demo
frontend/            React + Vite + TypeScript + Tailwind SPA
deploy/              docker-compose.yml, Dockerfiles, nginx.conf
loadtest/            k6 + chaos scripts ตาม test plan ในรายงาน
.github/workflows/   CI: go vet/build/test + frontend build ทุกครั้งที่ push
```

## วิธีรัน

ต้องมี Docker Desktop

```bash
cd deploy
docker compose up -d --build
```

คำสั่งนี้เปิด Postgres, Kafka, Redis, `api-server` 2 replica, `bid-worker` 1 ตัว, nginx (เสิร์ฟ
frontend และ proxy `/api` กับ `/ws` ไปที่ `api-*`), รวมถึง Prometheus, Grafana และ pgAdmin

เปิด **http://localhost:8080**

บัญชี demo (สร้างโดย `backend/migrations/0001_init.sql`) รหัสผ่านทั้งสองคือ `password123`:

| Email | บทบาท |
|---|---|
| `seller@example.com` | มีสินค้า demo 2 ชิ้น (เปิดประมูลอยู่ 1, ยังไม่เริ่ม 1) |
| `bidder@example.com` | บัญชีผู้บิดทั่วไป |

หรือสมัครบัญชีเองจากหน้าเว็บก็ได้

port ของแต่ละ service ถ้าต้องการข้าม nginx ตอน debug:

| Service | Host port |
|---|---|
| nginx (frontend + API/WS proxy) | 8080 |
| api-1 | 8081 |
| api-2 | 8082 |
| PostgreSQL | 5432 (`auction`/`auction`, db `auction`) |
| Redis | 6379 |
| Kafka | 9092 |
| pgAdmin | 5050 |
| Prometheus | 9090 |
| Grafana | 3000 |
| bid-worker metrics | 9101 |

หยุดทั้งหมดด้วย `docker compose down` (เติม `-v` ถ้าต้องการลบ volume ของ Postgres แล้วเริ่มจาก
ข้อมูล demo ใหม่ครั้งหน้า)

> **หมายเหตุ:** หลังเปิดเครื่องใหม่ ต้องเปิด Docker Desktop ก่อน แล้วรัน `docker compose up -d`
> อีกครั้ง ไม่งั้นบาง container (เช่น nginx, Grafana) อาจยังไม่ start

## ทดสอบ Redis Pub/Sub ด้วยตัวเอง

ทุกคำสั่งรันจากโฟลเดอร์ `deploy/` เตรียมก่อน: เปิด http://localhost:8080 ล็อกอินเป็น
`seller@example.com` สร้างสินค้าที่เริ่มทันที เปิดหน้าสินค้านั้นค้างไว้ แล้วจด item ID จาก URL
(`/auction/<item-id>`)

**วิธีที่ 1 — ดูข้อความที่วิ่งใน channel:**
```bash
docker compose exec redis redis-cli SUBSCRIBE auction:events
```
แล้วไปบิดจากอีกแท็บ (ล็อกอินเป็น `bidder@example.com`) จะเห็น JSON ของ `price_update` ขึ้นทันที
ทุกครั้งที่บิด ถ้าบิดต่ำเกินจะเห็น `bid_rejected` ที่มี `target_user_id` แนบมา (event เฉพาะคน)
กด `Ctrl+C` เพื่อออก

**วิธีที่ 2 — ปลอมข้อความเอง แล้วดูหน้าเว็บเปลี่ยนตาม:**
```bash
docker compose exec redis redis-cli
```
ใน `redis-cli` พิมพ์ (แทน `<item-id>` ด้วยของจริง):
```
PUBLISH auction:events '{"type":"price_update","item_id":"<item-id>","price":99999,"bidder_name":"FromRedisCLI"}'
```
- ราคาบนหน้าเว็บเปลี่ยนเป็น 99,999 ทันทีโดยไม่มีใครบิด — พิสูจน์ว่า api-server ส่งต่อทุกอย่างที่มา
  ทาง Redis
- ตัวเลข `(integer) 2` ที่ตอบกลับ = จำนวน api-server ที่ได้รับข้อความ
- กด refresh แล้วราคากลับเป็นของจริง เพราะ `sync` อ่านจาก Redis state ไม่ใช่จาก channel
  (ข้อความปลอมทำข้อมูลจริงเสียไม่ได้)

**วิธีที่ 3 — เพิ่ม api-server ตัวที่ 3 (จำลองการ scale):**
```bash
docker compose exec redis redis-cli PUBSUB NUMSUB auction:events
```
ได้ `2` (api-1, api-2) จากนั้นเปิด api-3 ที่ไม่มี config ไหนรู้จัก:
```bash
docker compose run -d --no-deps --name deploy-api-3 -p 8083:8080 api-1
```
รัน `PUBSUB NUMSUB` อีกครั้งจะได้ `3` — api-3 เข้ามาฟังเองโดยไม่มีใครบอก ลองเปิด WebSocket ตรงไปที่
`ws://localhost:8083/ws/auctions/<item-id>` แล้วบิดจากหน้าเว็บ (ผ่าน nginx → api-1/api-2) ก็จะ
ได้ `price_update` เช่นกัน เสร็จแล้วปิดด้วย:
```bash
docker rm -f deploy-api-3
```

ลบสินค้าทดสอบทิ้งหลังลองเสร็จ เพื่อไม่ให้ปนกับข้อมูล demo

## Observability (Prometheus + Grafana)

ทั้ง `api-server` และ `bid-worker` เปิด Prometheus metrics ที่ `/metrics` (`internal/metrics`
เป็นที่ประกาศ metric ทั้งหมด `promauto` ลงทะเบียนเข้า default registry ให้เอง binary ไหนที่ import
package นี้แค่เสิร์ฟ `promhttp.Handler()` ก็พอ) Prometheus scrape `api-1`, `api-2` และ
`bid-worker` ทุก 5 วินาที (`deploy/prometheus/prometheus.yml`) Grafana ตั้ง datasource และ
dashboard 2 ชุดไว้ให้แล้ว ไม่ต้องตั้งค่าเองเหมือน pgAdmin

เปิด **http://localhost:3000** แล้วล็อกอิน:

| ช่อง | ค่า |
|---|---|
| Username | `admin` (เปลี่ยนได้ด้วย `GRAFANA_USER`) |
| Password | `admin` (เปลี่ยนได้ด้วย `GRAFANA_PASSWORD`) |

| Dashboard | แสดงอะไร |
|---|---|
| **Auction - Application Overview** | WS connection ที่เปิดอยู่, อัตราบิดผ่าน/ไม่ผ่านและเหตุผลที่ไม่ผ่าน, จำนวนการประมูลที่ปิด (ขายได้/ไม่ได้), อัตรา HTTP request และ p95 latency แยกตาม route และ latency การตัดสินบิดของ `bid-worker` (p50/p95/p99) ซึ่งเป็นตัวเลขที่ NFR ในรายงานพูดถึงจริง ๆ |
| **Auction - k6 Load Test** | VUs, อัตรา HTTP request, p99 duration, failure rate, check pass rate และสถิติ WebSocket session/connect time — มีข้อมูลเมื่อ k6 push เข้า Prometheus (ดูหัวข้อ Grafana ใน `loadtest/README.md`) |

ชื่อ metric ที่ควรรู้ ถ้าจะเขียน query เองใน Prometheus (`http://localhost:9090`) หรือ Explore
ของ Grafana:

| Metric | Type | ความหมาย |
|---|---|---|
| `auction_ws_connections_active` | gauge | WS connection ที่เปิดอยู่ ณ ตอนนี้ ต่อ instance |
| `auction_bids_total{status,reason}` | counter | ผลการตัดสินบิดทุกครั้ง |
| `auction_bid_processing_duration_seconds` | histogram | latency ของ `handleBid` ตั้งแต่อ่าน Redis จนถึง publish ผล |
| `auction_items_finalized_total{outcome}` | counter | การประมูลที่ปิดแล้ว `sold`/`unsold` |
| `auction_http_requests_total{route,method,status}` | counter | REST request แยกตาม chi route pattern |
| `auction_http_request_duration_seconds{route,method}` | histogram | REST latency |

ตรวจสอบระหว่างพัฒนาแล้ว: สร้างบิดจริงผ่าน API แล้วยิง PromQL เดียวกับที่แต่ละ panel ใช้ตรงไปที่
HTTP API ของ Prometheus ก่อนเชื่อ dashboard — เช่น p99 ของการตัดสินบิดได้ 0.78ms สอดคล้องกับ
แนวคิด "ไม่มี disk I/O ใน fast path" ของสถาปัตยกรรม

## จัดการ database (pgAdmin)

ระบบใช้ PostgreSQL ไม่ใช่ Microsoft SQL Server จึงใช้ SQL Server Management Studio ต่อไม่ได้
`deploy/docker-compose.yml` จึงมี container **pgAdmin** ซึ่งเป็น GUI บนเบราว์เซอร์ (ดูตาราง,
query editor, แก้ไข row) ทำหน้าที่แบบเดียวกับ SSMS ชี้ไปที่ container `postgres`

```bash
cd deploy
docker compose up -d postgres pgadmin
```

เปิด **http://localhost:5050** แล้วล็อกอิน:

| ช่อง | ค่า |
|---|---|
| Email | `admin@auction.com` (เปลี่ยนได้ด้วย `PGADMIN_EMAIL`) |
| Password | `admin` (เปลี่ยนได้ด้วย `PGADMIN_PASSWORD`) |

ครั้งแรกครั้งเดียว ให้ลงทะเบียน server (คลิกขวา **Servers** → Register → Server):

| ช่อง | ค่า |
|---|---|
| Name | อะไรก็ได้ เช่น `auction` |
| Host name/address | `postgres` |
| Port | `5432` |
| Maintenance database | `auction` |
| Username | `auction` |
| Password | `auction` |

pgAdmin จำการเชื่อมต่อนี้ไว้ (เก็บใน volume `pgadmin-data`) ครั้งต่อไปไม่ต้องลงทะเบียนใหม่
เชื่อมต่อแล้วกางไปที่ `auction → Databases → auction → Schemas → public → Tables` จะเห็น
`users`, `items`, `bids` และ `audit_log`

`audit_log` (`backend/migrations/0002_audit_log.sql`) เป็น timeline เดียวที่เรียงตามเวลาของ
ทั้งวงจรบัญชีและการประมูล — `user.register`, `user.login`, `user.login_failed`,
`user.login_locked` (ดูเรื่อง lockout ด้านล่าง), `item.create`, `bid.accepted`, `bid.rejected`
(เหตุผลอยู่ใน `details`) และ `item.ended` (ผู้ชนะและราคาสุดท้าย หรือ `"no bids"`) ส่วน `bids`
ยังเป็น audit trail ต่อ item ตามที่รายงานกำหนด (§3.2.1) `audit_log` เป็นภาพรวมที่กว้างกว่า

### Migrations

`api-server` และ `bid-worker` จะ apply ไฟล์ `backend/migrations/*.sql` ที่ยังไม่เคยรันให้เองตอน
เริ่มทำงาน (`db.Migrate`, ไฟล์ถูก embed เข้า binary) และบันทึกไว้ในตาราง `schema_migrations`
แค่เพิ่มไฟล์ migration แล้วรัน `docker compose up -d --build` database เดิมก็อัพเกรดเลย ไม่ต้อง
`down -v` หรือรัน `psql` เอง มี Postgres advisory lock ให้ทั้ง 3 service ผลัดกัน ไฟล์หนึ่งจึงถูก
apply โดยตัวเดียว และเพราะ schema ถูกสร้างโดย service เหล่านี้ volume ใหม่จะเห็นตารางใน pgAdmin
หลัง `api-1` (หรือตัวไหนก็ได้) start ไปแล้วอย่างน้อยหนึ่งครั้ง

กติกาสำหรับไฟล์ migration ใหม่: ตั้งชื่อ `NNNN_description.sql` (apply ตามลำดับชื่อไฟล์),
ห้ามแก้ไฟล์ที่ปล่อยไปแล้ว และต้องรันซ้ำได้ไม่พัง (idempotent: `IF NOT EXISTS`,
`ON CONFLICT DO NOTHING` หรือบล็อก `DO $$ ... EXCEPTION WHEN duplicate_object`) — `0001`-`0003`
มีมาก่อน runner ครั้งแรกที่รันกับ database เก่าจึง apply ซ้ำหนึ่งรอบเพื่อเริ่มติดตาม

`0004_integrity.sql` เพิ่มการรับประกันความถูกต้องของข้อมูลที่โค้ดพึ่งพา:

| การเปลี่ยนแปลง | เหตุผล |
|---|---|
| `bids.request_id` UUID + `UNIQUE` | ทุกบิดได้ ID ตั้งแต่ตอน produce; `BatchInsertBids` ใช้ `ON CONFLICT (request_id) DO NOTHING` ดังนั้น Kafka ส่งซ้ำหลัง crash ก็เขียนแถวซ้ำไม่ได้ |
| `CHECK` บน `items` (`starting_price > 0`, `bid_increment > 0`, `end_time > start_time`, ผู้ชนะ ⇔ ราคาสุดท้าย ⇔ จบแล้ว) | แถวที่เขียนจากนอก API (pgAdmin, script) ทำลายสมมติฐานของ worker ไม่ได้ |
| `CHECK (email = lower(email))` บน `users` | `Bob@x.com` กับ `bob@x.com` เป็นสองบัญชีไม่ได้ |
| `idx_audit_log_entity` | ค้น timeline "ทุกอย่างที่เกิดกับ item X" ได้เร็ว |

Redis เปิด AOF persistence บน volume `redis-data` ถ้า live state หายอยู่ดี `bid-worker` จะสร้าง
ใหม่จากแถวที่ accepted สูงสุดใน `bids` การประมูลที่กำลังดำเนินอยู่จึงยังได้ราคาและผู้นำจริง ไม่ถูก
รีเซ็ต

## พัฒนา Backend

```bash
cd backend
go vet ./...
go build ./...
go test ./... -v         # internal/decision + internal/models ไม่ต้องเปิด service ใด ๆ
```

`internal/decision` เป็น pure function สำหรับตัดสินบิด (accept/reject, ขอบเขต anti-snipe,
บิดเท่ากันพร้อมกัน) ส่วน `internal/models` มี `MaskDisplayName` — ทั้งสองไม่มี I/O test จึงรัน
ทันทีและครอบคุณสมบัติความถูกต้องที่ส่วนอื่นของระบบพึ่งพา

Environment variables หลัก (ดู `internal/config/config.go` สำหรับรายการเต็มและค่าเริ่มต้น และ
`deploy/docker-compose.yml` ว่าต่อกันยังไง):

| Var | ความหมาย |
|---|---|
| `POSTGRES_URL`, `REDIS_ADDR`, `KAFKA_BROKERS` | ที่อยู่ของ service |
| `JWT_SECRET` | ต้องตรงกันทุก `api-*` instance |
| `BID_RATE_LIMIT_PER_SEC` | จำกัดจำนวนบิดต่อ WS connection (NFR ในรายงาน: 10/วินาที) |
| `ANTI_SNIPE_WINDOW` / `ANTI_SNIPE_EXTENSION` | ช่วงเวลา soft-close และเวลาที่ต่อให้ |

Login lockout (`maxFailedLoginAttempts` / `loginLockoutDuration` ใน
`internal/httpapi/auth_handlers.go` ตั้งผ่าน env ไม่ได้) ล็อกบัญชี 15 นาทีหลังใส่รหัสผิด 5 ครั้งติด
ระหว่างถูกล็อกแม้รหัสถูกก็ถูกปฏิเสธโดยไม่ตรวจเลย การเดารหัสจึงยืดเวลาล็อกไม่ได้
`RegisterFailedLogin` นับและล็อกใน `UPDATE` เดียวแบบ atomic ความพยายามที่เข้ามาพร้อมกันจึงหลุด
เกณฑ์ไม่ได้

## พัฒนา Frontend

```bash
cd frontend
npm install
npm run dev   # proxy /api และ /ws ไปที่ http://localhost:8080 — ต้องรัน api-1 ไว้ หรือชี้ไปที่ nginx ของ compose
```

หน้าเว็บครบทุกหน้าจอตามรายงาน §3.6: สมัคร/ล็อกอิน, dashboard (รายการ live/upcoming/ended พร้อม
นับถอยหลัง), ห้องประมูลสด (หน้าบิด + ประวัติบิดสดผ่าน WebSocket), ประกาศผู้ชนะ, เครื่องมือผู้ขาย
(สร้างและติดตามสินค้า) และประวัติการบิดของตัวเอง

ห้องประมูลสดมีป๊อปอัป 2 แบบจาก WebSocket event: สีแดงสำหรับบิดของตัวเองที่ไม่ผ่าน (ต่ำเกินไป,
ปิดประมูลแล้ว, ส่งถี่เกินไป, ยังไม่ล็อกอิน) และสีฟ้าเมื่อมีคนแซงราคาที่ตัวเองนำอยู่ (event `outbid`
ส่งเฉพาะผู้ที่เคยนำ คนอื่นเห็นแค่ราคาอัพเดทตามปกติ)

## ทดสอบ Load & ความถูกต้อง

`loadtest/` ทำตาม test plan ในรายงาน (TC-01..TC-04) และเพิ่มอีก 5 test เพื่อพิสูจน์สิ่งที่รายงาน
กล่าวไว้ในส่วนอื่นแต่ตารางไม่มี scenario (TC-05 soft-close extension, TC-06 worker crash/replay,
TC-07 reconnect resync, TC-08 scale-out fan-out, TC-09 api-server failover) รายละเอียดแต่ละตัว
และวิธีอ่านผลอยู่ใน `loadtest/README.md`

ทดสอบการ scale และ failover ของ api-server ได้เองด้วยคำสั่งเดียว (Node.js 22+, เปิด stack ไว้แล้ว):

```bash
cd loadtest
node chaos/tc08_scaleout_fanout.mjs   # เพิ่ม api-3 ที่ไม่มีใครรู้จัก แล้วตรวจว่า viewer ทุก instance ได้ราคาครบ
node chaos/tc09_api_failover.mjs      # kill api-1 กลางการประมูล แล้วตรวจว่าทุกคนต่อใหม่ได้ราคาล่าสุด
```

ทั้งสองตัวพิมพ์ `PASS`/`FAIL` ทีละข้อ และลบ container กับข้อมูลทดสอบที่สร้างทิ้งเองตอนจบ

```bash
cd loadtest
k6 run k6/tc02_race_condition_duel.js   # เช็คความถูกต้องแบบเร็ว เหมาะเป็นตัวแรก
./run_all.sh                            # รันทั้งหมดตามลำดับในรายงาน
```

**สคริปต์ demo สำหรับนำเสนอ (Windows):** `loadtest/demo_resilience.ps1` รันการทดสอบความทนทาน
ให้ดูทีละขั้นพร้อมสี — migration อัตโนมัติ, TC-06 (kill `bid-worker` กลางทาง) พร้อมตาราง `bids`
ที่ได้, และ nginx failover ตอนปิด api-1 — แล้วลบข้อมูลทดสอบเอง ใช้เวลาประมาณ 1 นาที รันใน
หน้าต่าง PowerShell ของ Windows (แท็บ terminal ในบาง IDE ตัดคำสั่งที่รันนาน):

```powershell
powershell -ExecutionPolicy Bypass -File loadtest\demo_resilience.ps1
```

**ข้อจำกัดของ environment ที่ควรรู้** (ตรงกับที่รายงาน §3.5.1 เตือนไว้): รัน k6 เกิน ~200-300
virtual users *จากเครื่อง Windows* ไปที่ port ที่ `docker compose` publish ไว้ อาจชนขีดจำกัดของ
port-forwarding ระหว่าง host↔container ของ Docker Desktop ก่อนถึงขีดจำกัดจริงของระบบ ทำให้เห็น
WS handshake ล้มเหลวทั้งที่ไม่เกี่ยวกับแอป วิธีแก้ที่ใช้จริงระหว่างพัฒนา: รัน k6 ภายใน compose
network เลย traffic จะไม่ผ่านชั้น network ของ host:

```bash
docker run --rm --network deploy_default \
  -v "$(pwd)/loadtest:/scripts" -w /scripts \
  -e BASE_URL=http://nginx \
  grafana/k6 run k6/tc01_fanout_broadcast.js
```

TC-01 (500 VUs), TC-03 (2000 VUs) และ TC-04 (1000 VUs) ผ่านทั้งหมดด้วยวิธีนี้

อาการที่มาจากสาเหตุเดียวกัน: หลังรัน load test หนัก ๆ ใส่ `localhost:8080` บน Windows
WebSocket connection ใหม่ผ่าน port นั้นอาจค้างไปเลย (HTTP ธรรมดายังใช้ได้) เพราะชั้น
port-forwarding ของ Docker Desktop สะสม connection state ที่ค้างอยู่ ถ้าเกิดขึ้น
`docker compose restart nginx api-1 api-2` แก้ได้ทันที — ทดลองซ้ำและยืนยันแล้วระหว่างพัฒนา
ไม่ใช่บั๊กของแอป

## Continuous Integration

`.github/workflows/ci.yml` รันทุกครั้งที่ push/PR ทุก branch มี 2 job ทำงานขนานกัน:

| Job | ขั้นตอน |
|---|---|
| Backend | `go vet ./...` → `go build ./...` → `go test ./... -v` |
| Frontend | `npm ci` → `npm run build` (`tsc -b` ตรวจ type แล้ว `vite build`) |

ไม่ต้องเปิด service จริง ทั้งสอง job รันกับ checkout เปล่า ๆ ตรงกับวิธีที่ `internal/decision`/
`internal/models` และ frontend build ถูกออกแบบให้ตรวจ ดูประวัติการรันได้ที่แท็บ **Actions** บน
GitHub ส่วน badge ด้านบนไฟล์นี้แสดงผลรอบล่าสุดของ branch ที่ GitHub เลือกเป็นค่าเริ่มต้น

## สิ่งที่ตั้งใจไม่ทำ (ตอนนี้)

ตาม scope ที่ตกลงไว้ ตอนนี้เป็นการ deploy ด้วย Docker Compose ไม่ใช่ Kubernetes cluster จริง —
`api-1`/`api-2` เป็นตัวแทนของ Deployment ที่ HPA จะ scale และรายชื่อ upstream แบบคงที่ของ nginx
เป็นตัวแทนของ K8s Service/Ingress สถาปัตยกรรม (API server แบบ stateless, worker แบบ single
sequential consumer, broadcast ผ่าน Pub/Sub, commit offset หลังเขียนสำเร็จ) เหมือนกันทุกอย่าง
ต่างแค่กลไกการ scale
