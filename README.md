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

**ทำไมบิดทันเวลาไม่หาย แม้ worker ตามงานไม่ทัน:** พอถึงเวลาปิด `bid-worker` ไม่ได้ปิดประมูลเลย แต่จะรออีก
2.5 วินาที (`models.BidExpiry` บิดที่ส่งทันเวลาไม่มีทางมาถึง Kafka ช้ากว่านี้) แล้วส่ง **close marker** เข้า
Kafka partition เดียวกับบิดของสินค้านั้น แล้วปิดตอนอ่าน marker กลับมาได้ ซึ่งแปลว่าบิดทุกตัวที่เข้าคิวก่อนหน้าถูก
ตัดสินครบแล้ว ถ้ามีบิดในคิวต่อเวลา (anti-snipe) marker จะไม่มีผล การประมูลจึงแสดงผู้ชนะหลังเวลาปิดประมาณ 3
วินาที — ทดสอบด้วย TC-13

**ถ้าบันทึกบิดลง Postgres ไม่ได้อย่างถาวร ระบบไม่ค้าง:** เช่นสินค้าถูกลบด้วยมือระหว่างที่ยังมีคนบิด `bid-worker`
เขียนทีละแถวเพื่อแยกแถวที่มีปัญหาออก บันทึกลง `audit_log` เป็น `bid.dropped` แล้วทำงานต่อ ส่วนความล้มเหลว
ชั่วคราว (Postgres ล่ม) ยัง retry จนสำเร็จเหมือนเดิม — ทดสอบด้วย TC-14

**ถ้า Postgres ล่ม การบิดยังทำงาน:** การตัดสินบิดใช้แค่ Kafka + Redis ส่วน Postgres เป็นแค่บันทึก
ถาวร `bid-worker` เขียนแถว `bids` พร้อม `audit_log` ของบิดนั้นใน statement เดียวผ่านคิวที่ retry
จนสำเร็จ (`writeLoop`) และอ่าน Postgres สำหรับเปิด/ปิดประมูลใน goroutine แยก (`lifecycleLoop`)
loop ที่ตัดสินบิดจึงไม่ต้องรอ Postgres เลย พอ Postgres กลับมาบันทึกที่ค้างจะถูกเขียนครบเอง ข้อจำกัด:
REST ที่ต้องอ่าน Postgres (รายการสินค้า, login, เปิดหน้าประมูลใหม่) ใช้ไม่ได้ระหว่างนั้น — ทดสอบด้วย
TC-11

**ถ้า Kafka ล่ม ผู้ใช้รู้ทันที:** api-server รอ Kafka 3 วินาที (`models.BidPublishTimeout`) ถ้าไม่ได้
จะตอบ `service_unavailable` และ broker ถูกตั้งให้ปฏิเสธบิดที่มาถึงช้ากว่า 2.5 วินาทีนับจากเวลาที่บิด
(`models.BidExpiry` → topic config `message.timestamp.before.max.ms`, api-server ตั้งให้ตอน start)
เพราะ Kafka client ยัง retry ข้อความเองต่อหลัง api-server เลิกรอ ถ้าไม่มีกฎนี้ บิดที่ผู้ใช้ถูกบอกว่า
"ไม่ถูกบันทึก" จะเข้าระบบทีหลังตอน Kafka กลับมาได้ — ทดสอบด้วย TC-10

**ถ้า Redis ล่ม ผู้ใช้ก็รู้ทันที:** `bid-worker` ต้องใช้ Redis ทั้งตัดสินบิดและแจ้งผล api-server จึงเช็ก Redis
อยู่ตลอดทุก 0.5 วินาที (`Deps.WatchRedis`) และตอบ `service_unavailable` ทันทีโดยไม่ส่งบิดเข้า Kafka ช่วงแรก
สุดประมาณ 2.5 วินาทีที่ยังตรวจไม่พบ บิดอาจไม่ได้คำตอบ — ทดสอบด้วย TC-12

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
ประวัติบิด รายการสินค้า และประกาศผู้ชนะ และ `user_id`/`winner_id` จะไม่ถูกส่งให้คนอื่นด้วย ไม่งั้นใช้ ID
ติดตามคนเดิมข้ามสินค้าได้ ข้อมูลใน database ไม่ถูกแก้ไข การปิดชื่อทำเฉพาะชั้น serialization ของ response
ตาม request/ผู้รับแต่ละคน

**ผู้ขายบิดสินค้าตัวเองไม่ได้:** api-server ปฏิเสธด้วย `seller_cannot_bid` (กันการปั่นราคา) และหน้าเว็บจะไม่แสดง
ช่องเสนอราคาให้ผู้ขาย

**จำนวนเงิน:** มีทศนิยมได้ไม่เกิน 2 ตำแหน่ง (เท่ากับที่ Postgres เก็บ) และเปรียบเทียบเป็นสตางค์ ไม่ใช่ float

## โครงสร้าง repo

```
backend/            Go module: cmd/api-server, cmd/bid-worker, internal/*
  migrations/        Postgres schema + ข้อมูล demo
frontend/            React + Vite + TypeScript + Tailwind SPA
deploy/              docker-compose.yml, Dockerfiles, nginx.conf
k8s/                 Kubernetes manifests (kustomize) + HPA, run-k6.ps1
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
| PostgreSQL | 5432 (`auction`/`auction`, db `auction`) — เฉพาะเครื่องนี้ (`127.0.0.1`) |
| Redis | 6379 — เฉพาะเครื่องนี้ |
| Kafka | 9092 — เฉพาะเครื่องนี้ |
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
(`/auctions/<item-id>`)

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

ลบสินค้าทดสอบทิ้งหลังลองเสร็จ เพื่อไม่ให้ปนกับข้อมูล demo (บิดที่ยังส่งเข้ามาหลังลบจะถูกบันทึกเป็น `bid.dropped`)

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
| `auction_bids_dropped_total` | counter | บิดที่ Postgres ไม่มีวันรับ (เช่นสินค้าถูกลบ) ดูรายละเอียดใน `audit_log` |
| `auction_bid_processing_duration_seconds` | histogram | latency ของ `handleBid` ตั้งแต่อ่าน Redis จนถึง publish ผล |
| `auction_items_finalized_total{outcome}` | counter | การประมูลที่ปิดแล้ว `sold`/`unsold` |
| `auction_http_requests_total{route,method,status}` | counter | REST request แยกตาม chi route pattern |
| `auction_http_request_duration_seconds{route,method}` | histogram | REST latency |

ตรวจสอบระหว่างพัฒนาแล้ว: สร้างบิดจริงผ่าน API แล้วยิง PromQL เดียวกับที่แต่ละ panel ใช้ตรงไปที่
HTTP API ของ Prometheus ก่อนเชื่อ dashboard — เช่น p99 ของการตัดสินบิดได้ 0.78ms สอดคล้องกับ
แนวคิด "ไม่มี disk I/O ใน fast path" ของสถาปัตยกรรม

บน Kubernetes มี Prometheus และ Grafana ด้วย (port เดียวกัน) Prometheus ค้นหา pod เองแทนรายชื่อตายตัว
และมี dashboard เพิ่มอีกตัว **Auction - Kubernetes Scaling** ที่แสดงจำนวน api-server pod คู่กับ CPU ที่ HPA
ใช้ตัดสิน — ดู [`k8s/README.md`](k8s/README.md#prometheus--grafana)

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
(เหตุผลอยู่ใน `details`), `bid.dropped` (บันทึกลง `bids` ไม่ได้อย่างถาวร) และ `item.ended` (ผู้ชนะและราคาสุดท้าย
หรือ `"no bids"`) คอลัมน์ `ip_address` เป็น IP ของผู้ใช้จาก header `X-Real-IP` ที่ nginx ตั้งให้ ส่วน `bids`
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
go test ./... -v         # ไม่ต้องเปิด service ใด ๆ (test ที่ต้องใช้ database จะ skip เอง)
```

`internal/decision` เป็น pure function สำหรับตัดสินบิด (accept/reject, ขอบเขต anti-snipe,
บิดเท่ากันพร้อมกัน, เปรียบเทียบเงินเป็นสตางค์) `internal/models` มี `MaskDisplayName` และกฎจำนวนเงิน
`internal/httpapi` ตรวจ input ของ API และ `internal/ws` ตรวจ Origin ของ WebSocket — ไม่มี I/O test จึงรันทันที

test ใน `internal/db` (lockout ภายใต้ request พร้อมกัน, การจำแนก error ของ batch insert) ต้องใช้ Postgres จริง
ชี้ไปที่ database ที่เปิดอยู่ด้วย `TEST_POSTGRES_URL` (CI ทำให้เอง):

```powershell
$env:TEST_POSTGRES_URL="postgres://auction:auction@localhost:5432/auction?sslmode=disable"; go test ./internal/db -v
```

Environment variables หลัก (ดู `internal/config/config.go` สำหรับรายการเต็มและค่าเริ่มต้น และ
`deploy/docker-compose.yml` ว่าต่อกันยังไง):

| Var | ความหมาย |
|---|---|
| `POSTGRES_URL`, `REDIS_ADDR`, `KAFKA_BROKERS` | ที่อยู่ของ service |
| `POSTGRES_MAX_CONNS` | ขนาด connection pool ต่อ process (ค่าเริ่มต้น 20) — ผลรวมทุก instance ต้องไม่เกิน `max_connections` ของ Postgres |
| `JWT_SECRET` | ต้องตรงกันทุก `api-*` instance |
| `CORS_ORIGIN` | origin ที่อนุญาตสำหรับ REST และ WebSocket (ค่าเริ่มต้น `http://localhost:8080`) |
| `BID_RATE_LIMIT_PER_SEC` | จำกัดจำนวนบิดต่อ WS connection (NFR ในรายงาน: 10/วินาที) |
| `ANTI_SNIPE_WINDOW` / `ANTI_SNIPE_EXTENSION` | ช่วงเวลา soft-close และเวลาที่ต่อให้ |

Login lockout (`maxFailedLoginAttempts` / `loginLockoutDuration` ใน
`internal/httpapi/auth_handlers.go` ตั้งผ่าน env ไม่ได้) ล็อกบัญชี 15 นาทีหลังใส่รหัสผิด 5 ครั้งติด
ระหว่างถูกล็อกแม้รหัสถูกก็ถูกปฏิเสธโดยไม่ตรวจเลย การเดารหัสจึงยืดเวลาล็อกไม่ได้
`ClaimLoginAttempt` นับและล็อกใน `UPDATE` เดียว**ก่อน**ตรวจรหัส ส่ง request มาพร้อมกันกี่ตัวก็ตรวจรหัสได้ไม่เกิน 5
ครั้ง (รหัสถูกจะล้างตัวนับ) — พิสูจน์ด้วย test ที่ยิงพร้อมกัน 40 ตัวใน `internal/db`

## พัฒนา Frontend

```bash
cd frontend
npm install
npm run dev   # proxy /api และ /ws ไปที่ http://localhost:8080 — ต้องรัน api-1 ไว้ หรือชี้ไปที่ nginx ของ compose
npm run lint
npm test      # กฎราคาขั้นต่ำ, จำนวนเงิน, บิดที่นำอยู่ (src/lib/bidding.test.ts)
```

หน้าเว็บครบทุกหน้าจอตามรายงาน §3.6: สมัคร/ล็อกอิน, dashboard (รายการ live/upcoming/ended พร้อม
นับถอยหลัง), ห้องประมูลสด (หน้าบิด + ประวัติบิดสดผ่าน WebSocket), ประกาศผู้ชนะ, เครื่องมือผู้ขาย
(สร้างและติดตามสินค้า) และประวัติการบิดของตัวเอง

ห้องประมูลสดมีป๊อปอัป 2 แบบจาก WebSocket event: สีแดงสำหรับบิดของตัวเองที่ไม่ผ่าน (ต่ำเกินไป,
ปิดประมูลแล้ว, ส่งถี่เกินไป, ยังไม่ล็อกอิน) และสีฟ้าเมื่อมีคนแซงราคาที่ตัวเองนำอยู่ (event `outbid`
ส่งเฉพาะผู้ที่เคยนำ คนอื่นเห็นแค่ราคาอัพเดทตามปกติ)

## ทดสอบ Load & ความถูกต้อง

`loadtest/` ทำตาม test plan ในรายงาน (TC-01..TC-04) และเพิ่มอีก 10 test เพื่อพิสูจน์สิ่งที่รายงาน
กล่าวไว้ในส่วนอื่นแต่ตารางไม่มี scenario (TC-05 soft-close extension, TC-06 worker crash/replay,
TC-07 reconnect resync, TC-08 scale-out fan-out, TC-09 api-server failover, TC-10 Kafka restart,
TC-11 Postgres outage, TC-12 Redis outage, TC-13 ปิดประมูลตอนมีบิดค้างในคิว, TC-14 สินค้าถูกลบกลางการประมูล)
รายละเอียดแต่ละตัว และวิธีอ่านผลอยู่ใน `loadtest/README.md`

ทดสอบการ scale และ failover ของ api-server ได้เองด้วยคำสั่งเดียว (Node.js 22+, เปิด stack ไว้แล้ว):

```bash
cd loadtest
node chaos/tc08_scaleout_fanout.mjs   # เพิ่ม api-3 ที่ไม่มีใครรู้จัก แล้วตรวจว่า viewer ทุก instance ได้ราคาครบ
node chaos/tc09_api_failover.mjs      # kill api-1 กลางการประมูล แล้วตรวจว่าทุกคนต่อใหม่ได้ราคาล่าสุด
```

ทั้งสองตัวพิมพ์ `PASS`/`FAIL` ทีละข้อ และลบ container กับข้อมูลทดสอบที่สร้างทิ้งเองตอนจบ

ทดสอบตอน Kafka หรือ Postgres ล่มกลางการประมูล (หยุด service จริงแล้วเปิดกลับเอง):

```bash
cd loadtest
node chaos/tc10_kafka_restart.mjs     # หยุด Kafka 10 วินาที: ทุกบิดได้คำตอบ, "ระบบขัดข้อง" = ไม่ถูกบันทึกจริง
node chaos/tc11_postgres_outage.mjs   # หยุด Postgres 15 วินาที: บิดยัง real-time, bids/audit_log ครบหลังกลับมา
node chaos/tc12_redis_outage.mjs      # หยุด Redis 10 วินาที: บิดได้คำตอบ "ระบบขัดข้อง" ทันที, กลับมาบิดได้เอง
node chaos/tc13_close_with_backlog.mjs # หยุด bid-worker จนเลยเวลาปิด: บิดที่ส่งทันเวลาต้องนับทุกตัว
node chaos/tc14_deleted_item.mjs      # ลบสินค้าที่กำลังประมูล: บิดของสินค้าอื่นยังบันทึกได้ปกติ
```

ทั้งสองตัวพิมพ์ผลของทุกบิด (`[down] bid 150 -> accepted in 16ms` เป็นต้น) ให้เห็นว่าระหว่างล่มเกิดอะไรขึ้น
ลองเองผ่านหน้าเว็บก็ได้: เปิดหน้าประมูลไว้แล้ว `docker compose -f deploy/docker-compose.yml stop postgres`
→ บิดต่อได้ปกติ → `start postgres` แล้วดูใน pgAdmin ว่าบิดระหว่างนั้นอยู่ใน `bids` และ `audit_log` ครบ
หรือ `stop kafka` → บิดแล้วจะได้ป๊อปอัป "ระบบขัดข้องชั่วคราว การเสนอราคานี้ไม่ถูกบันทึก" → `start kafka`
แล้วรอ ~15 วินาที ราคาจะไม่เปลี่ยนจากบิดที่ถูกปฏิเสธไป และบิดใหม่ผ่านตามปกติ

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

`.github/workflows/ci.yml` รันทุกครั้งที่ push/PR ทุก branch มี 3 job ทำงานขนานกัน:

| Job | ขั้นตอน |
|---|---|
| Backend | `go vet ./...` → `go build ./...` → `go test ./... -v` (มี Postgres ให้ test ใน `internal/db`) |
| Grafana dashboards in sync | dashboard ของ compose กับ `k8s/` ต้องตรงกัน |
| Frontend | `npm ci` → `npm run lint` → `npm test` → `npm run build` (`tsc -b` ตรวจ type แล้ว `vite build`) |

load test กับ chaos test ใน `loadtest/` ไม่ได้อยู่ใน CI เพราะต้องเปิดทั้งระบบ ดูประวัติการรันได้ที่แท็บ **Actions** บน
GitHub ส่วน badge ด้านบนไฟล์นี้แสดงผลรอบล่าสุดของ branch ที่ GitHub เลือกเป็นค่าเริ่มต้น

## ค่าเริ่มต้นที่ใช้ได้เฉพาะในเครื่อง

ระบบนี้ตั้งค่ามาให้รันบนเครื่องตัวเอง ก่อนเปิดให้เครื่องอื่นเข้าถึงต้องเปลี่ยน: `JWT_SECRET` (api-server จะเตือนใน
log ถ้ายังเป็นค่าเริ่มต้น), รหัสผ่าน Postgres/Grafana/pgAdmin และ `CORS_ORIGIN`

## Kubernetes (local)

นอกจาก compose ระบบเดียวกันรันบน Kubernetes ของ Docker Desktop ได้ด้วย (`k8s/`) โดย api-server เป็น
Deployment ที่ **HorizontalPodAutoscaler เพิ่ม/ลด pod เองตาม CPU (2–6 pod)** แทน api-1/api-2 ที่ตายตัว
และ pod ที่ตายจะถูกสร้างใหม่เอง สถาปัตยกรรมอื่นเหมือนเดิมทุกอย่าง (API server แบบ stateless, worker
แบบ single sequential consumer, broadcast ผ่าน Redis Pub/Sub, commit offset หลังเขียนสำเร็จ)

```bash
kubectl apply -k k8s
```

วิธีติดตั้ง (build image, metrics-server) วิธีดู HPA scale สด (ใน Grafana ที่ http://localhost:3000 หรือ
`kubectl`), self-healing, การรัน TC-08 ถึง TC-11 บน K8s และผลทดสอบอยู่ใน [`k8s/README.md`](k8s/README.md)

ผลสำคัญ: ยิงโหลด 300 VU ต่อเนื่อง HPA เพิ่ม api-server จาก 2 → 6 pod แล้วลดกลับเมื่อโหลดหยุด
และการ scale จริงเจอปัญหาที่ compose ไม่เคยเจอ — connection pool ของ 6 pod รวมกันเกิน
`max_connections` ของ Postgres ทำให้ request 0.22% ได้ 500 แก้แล้วด้วย `POSTGRES_MAX_CONNS`
(รายละเอียดใน `k8s/README.md`)

`POSTGRES_MAX_CONNS` (ค่าเริ่มต้น 20) คือขนาด connection pool ของแต่ละ process — ผลรวมของทุก
api-server และ bid-worker ที่รันพร้อมกันต้องไม่เกิน `max_connections` ของ Postgres (100)
