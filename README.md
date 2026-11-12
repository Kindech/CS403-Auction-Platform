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
                  │ Redis │  │ PostgreSQL │     รูปสินค้า: api-* เขียนลง SeaweedFS (S3 API)
                  │(state)│  │(audit log, │     nginx เสิร์ฟให้ browser ที่ /images/
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
"ไม่ถูกบันทึก" จะเข้าระบบทีหลังตอน Kafka กลับมาได้ — ทดสอบด้วย TC-10 บน Kubernetes Kafka เป็น
cluster 3 broker (KRaft) broker ตาย 1 ตัวบิดยังผ่านต่อได้โดยไม่ต้องรอมัน restart — ดู
[Kafka: กลับมาเร็วหลัง restart และ 3 broker](#kafka-กลับมาเร็วหลัง-restart-และ-3-broker-บน-kubernetes) และ TC-16

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
deploy/              docker-compose.yml, Dockerfiles, nginx.conf, seaweedfs/s3.json
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

**ดู Postgres บน Kubernetes ด้วย pgAdmin ตัวเดียวกัน:** เปิด port-forward ทิ้งไว้ในอีก terminal
```powershell
kubectl -n auction port-forward svc/postgres 5433:5432
```
แล้วลงทะเบียน server อีกตัวด้วย Host `host.docker.internal`, Port `5433` (ช่องอื่นเหมือนตารางข้างบน)
ถ้าเชื่อมต่อไม่ได้ ให้เช็กว่า container `deploy-pgadmin-1` ยังรันอยู่ และ port-forward ยังไม่หลุด

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

Redis เปิด AOF persistence (`appendfsync everysec`) บน volume `redis-data` ถ้า live state หายอยู่ดี
`bid-worker` จะซ่อมจาก Postgres ทุกรอบ lifecycle (ทุก 1 วินาที) ด้วย query เดียว (`LeadingBidsForLiveItems`):

- **key หายทั้งหมด** (volume หาย, Redis เปิดใหม่โดยไม่มีข้อมูล) → สร้างใหม่จากบิด accepted สูงสุดใน `bids`
- **key ยังอยู่แต่ล้าหลัง** (reconcile) → ถ้า Postgres มีบิด accepted ที่สูงกว่าราคาใน Redis หรือ `end_time`
  ที่ถูก anti-snipe เลื่อนไปไกลกว่า ให้ใช้ค่าจาก Postgres ทุกแถวใน Postgres ผ่าน Redis มาก่อนเสมอ
  ดังนั้น Postgres "นำหน้า" Redis ได้ทางเดียวคือ Redis ทำข้อมูลที่ตอบรับไปแล้วหาย เช่นเครื่องดับทำให้
  AOF วินาทีสุดท้ายไม่ถูกเขียนลงดิสก์ — ซ่อมแค่ "ไปข้างหน้า" จึงไม่ไปทับบิดใหม่ที่ยังรอเขียนลง Postgres

ทุกครั้งที่ซ่อมจะนับใน metric `auction_redis_state_repairs_total{kind="rebuilt"|"reconciled"}` และมี log
`redis state of item ... was behind postgres` ใน `bid-worker`

ข้อจำกัดที่เหลือ: ระหว่างที่ Redis ล้าหลังจนถึงรอบ lifecycle ถัดไป (ไม่เกิน ~1 วินาที) บิดที่ต่ำกว่าราคาจริงอาจถูก
รับได้ ผู้ชนะยังถูกต้องเพราะ reconcile คืนบิดที่สูงกว่า แต่ใน `bids` จะมีแถว accepted ที่ราคาต่ำกว่าผู้นำ

**ทดสอบเอง (Redis ตายแบบ kill -9 และข้อมูลหาย):**
```bash
cd loadtest
```
```powershell
$env:TARGET="k8s"; node chaos/tc15_redis_crash.mjs
```
(compose: `node chaos/tc15_redis_crash.mjs`) หรือลองด้วยมือ — เปิดหน้าประมูลค้างไว้ บิดสักสองสามครั้ง แล้วย้อนราคาใน
Redis เองให้เหมือนข้อมูลหาย (ใส่ `<item-id>` จาก URL และราคาที่ต่ำกว่าราคาปัจจุบัน):
```bash
kubectl -n auction exec redis-0 -- redis-cli HSET item:<item-id>:state price 100
```
ภายใน ~1 วินาทีอ่านค่าอีกครั้งจะได้ราคาจริงกลับมา และ log ของ worker บอกว่าซ่อมแล้ว:
```bash
kubectl -n auction exec redis-0 -- redis-cli HGET item:<item-id>:state price
```
```bash
kubectl -n auction logs deploy/bid-worker --tail=5
```

## รูปสินค้า: หลายรูปต่อสินค้า อัปโหลดจากเครื่อง

ผู้ขายเลือกรูปจากเครื่องได้ (กดเลือกหรือลากไฟล์มาวาง) สูงสุด **10 รูปต่อสินค้า** รูปละไม่เกิน **8 MB** (JPG, PNG,
WebP, GIF) รูปแรกคือรูปปกที่แสดงบนการ์ดสินค้า กด "ตั้งเป็นรูปปก" ที่รูปอื่นเพื่อเปลี่ยนได้ ในหน้าประมูลจะเป็นแกลเลอรี
ที่มีรูปย่อให้คลิกเปลี่ยน

**ทำไมเก็บรูปใน object storage แทน disk ของ api-server:** api-server มี 2–6 pod ที่ HPA สร้างและลบได้ตลอดเวลา
ถ้ารูปอยู่บน disk ของ pod ใด พอ pod นั้นถูกลบรูปก็หายไปด้วย และ pod อื่นก็มองไม่เห็นรูปนั้น ทุก pod จึงเขียนรูปลงที่
เดียวกัน คือ **SeaweedFS** (`k8s/seaweedfs.yaml` และ service `seaweedfs` ใน compose) ซึ่งเป็น object storage ที่ใช้
S3 API แบบเดียวกับ AWS S3 ส่วน nginx เสิร์ฟรูปให้ browser โดยตรงที่ `/images/...` โดยไม่ผ่าน api-server

- **ทำไมใช้ SeaweedFS แทน MinIO:** MinIO เลิกเผยแพร่ Docker image แล้ว (`minio/minio` บน Docker Hub ได้ 404
  และดึงจาก quay.io ไม่ได้) api-server ใช้ S3 client มาตรฐาน (`minio-go`) จึงย้ายไปใช้ MinIO ที่มีอยู่แล้วหรือ AWS S3
  ได้โดยเปลี่ยนแค่ `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`
- **ลำดับการทำงาน:** browser ส่งรูปทีละรูปไปที่ `POST /api/uploads/images` (ต้อง login) → api-server ตรวจชนิดไฟล์
  จาก byte จริงของไฟล์ ไม่เชื่อนามสกุลหรือ header ที่ browser ส่งมา (ไฟล์ HTML ที่ตั้งชื่อเป็น .png จะได้ 415) และตั้ง
  ชื่อไฟล์ใหม่แบบสุ่ม → คืน URL `/images/items/<สุ่ม>.jpg` → ตอนกดลงประมูล frontend ส่ง URL ทั้งหมดไปใน `image_urls`
- **ความปลอดภัย:** bucket ให้คนทั่วไป*อ่าน*ไฟล์ได้อย่างเดียว list และเขียนไม่ได้ (`deploy/seaweedfs/s3.json`) nginx
  ส่งต่อเฉพาะ GET และใส่ `X-Content-Type-Options: nosniff` ส่วน `image_urls` ตอนสร้างสินค้ารับเฉพาะ path ที่ได้จาก
  การอัปโหลด หรือ URL แบบ http(s)
- **ใช้กับของเดิมได้:** migration `0005_item_images.sql` เพิ่มคอลัมน์ `image_urls` และคัดลอก `image_url` เดิมเข้าไป
  `image_url` ยังอยู่และเป็นรูปปกเสมอ client เก่าและ load test ที่ส่ง `image_url` ช่องเดียวจึงใช้ได้เหมือนเดิม
- **ข้อจำกัด:** SeaweedFS มีตัวเดียวเหมือน Postgres และ Redis ถ้าล่ม รูปจะไม่ขึ้นและอัปโหลดไม่ได้ แต่การประมูลยังทำงาน
  ปกติ รูปที่อัปโหลดแล้วแต่ไม่ได้กดลงประมูลจะค้างอยู่ใน bucket (ยังไม่มีงานลบรูปที่ไม่ได้ใช้)

**วิธีทดสอบ**

1. เข้า http://localhost:8080 ด้วย `seller@example.com` / `password123` แล้วไปที่เมนู "ลงประมูลสินค้า"
2. กด "+ เพิ่มรูป" แล้วเลือกหลายรูปพร้อมกัน (หรือลากมาวาง) รูปจะขึ้นเป็นรูปย่อ ลองกด "ตั้งเป็นรูปปก" และกด × เพื่อลบรูป
3. กดลงประมูล แล้วเปิดสินค้านั้น ต้องเห็นรูปปกเป็นรูปแรก มีรูปย่อด้านล่าง ปุ่ม ‹ › และตัวนับ "1 / 3"
4. ทดสอบฝั่ง API ด้วย curl (Git Bash) โดยเอา token จากการ login มาใช้:
   ```bash
   TOKEN=$(curl -s localhost:8080/api/auth/login -H 'content-type: application/json' -d '{"email":"seller@example.com","password":"password123"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
   ```
   ```bash
   curl -s -w ' %{http_code}\n' -H "Authorization: Bearer $TOKEN" -F file=@photo.jpg localhost:8080/api/uploads/images
   ```
   ต้องได้ `{"url":"/images/items/....jpg"} 201` และเปิด URL นั้นใน browser ได้ ส่วนกรณีที่ต้องถูกปฏิเสธ:

   | ส่งอะไร | ผลที่ต้องได้ |
   |---|---|
   | ไม่มี token | 401 |
   | ไฟล์ที่ไม่ใช่รูป (เช่น HTML ที่ตั้งชื่อเป็น .png) | 415 |
   | ไฟล์ใหญ่เกิน 8 MB | 413 |
   | `curl -X PUT localhost:8080/images/items/x` | 403 |
   | `curl localhost:8080/images/` (ขอรายชื่อไฟล์ทั้ง bucket) | 403 |
   | สร้างสินค้าด้วย `"image_urls":["/api/me"]` | 400 |

5. ดูว่า api-server ต่อ bucket ได้:
   ```bash
   kubectl -n auction logs deploy/api-server | grep images:
   ```
   ต้องเห็น `images: bucket item-images on seaweedfs:8333 ready`

## หน้าห้องประมูล: สถิติและประวัติแบบเรียลไทม์ และหน้าสรุปผู้ชนะ

ทำตามหน้าที่ออกแบบไว้ในรายงาน

**ห้องประมูลที่กำลังเปิดอยู่** (`frontend/src/pages/AuctionRoom.tsx`) ใต้รูปและราคามี 2 แท็บ
- **รายละเอียดสินค้า**: คำอธิบาย ราคาเริ่มต้น ราคาที่ต้องเพิ่มขั้นต่ำ เวลาเริ่มและสิ้นสุด (รวมเวลาที่ถูกต่อจาก anti-snipe) และผู้ขาย
- **ประวัติการประมูล (n)**: การ์ดสถิติ 4 ใบ (จำนวนการเสนอราคา, ผู้เข้าร่วม, ราคาเพิ่มขึ้นกี่ % จากราคาเริ่มต้น,
  ราคาสูงสุด) ตารางจัดอันดับตามราคา (อันดับ, รูปย่อตัวอักษรแรก, ชื่อแบบปิดบัง, จำนวนเงิน, วันที่/เวลา, ป้าย "สูงสุด")
  ที่ค้นหาชื่อได้และเรียงตามราคาหรือเวลาได้ และแผง **การเสนอราคาสด** ด้านขวา

ทุกอย่างคำนวณใหม่ทุกครั้งที่ WebSocket ส่งบิดใหม่เข้ามา จึงไม่ต้อง refresh หน้า และนับเฉพาะบิดที่ถูกรับ (accepted)

**หน้าสรุปผู้ชนะ** (`frontend/src/components/WinnerAnnouncement.tsx`) แสดงเมื่อการประมูลจบ: ถ้วยรางวัลพร้อม
"ขอแสดงความยินดี" (ถ้าผู้ชนะเปิดดูเองจะขึ้นว่า "คุณชนะการประมูล!") ราคาที่ชนะ แถบสถิติ (จำนวนการเสนอราคา, ผู้เข้าร่วม,
ราคาเพิ่มขึ้น, วันที่สิ้นสุด) การ์ดสินค้า (แกลเลอรีรูป, คำอธิบาย, ราคาเริ่มต้นและราคาสุดท้าย, ผู้ขาย, เวลาเริ่มและสิ้นสุด)
และตารางประวัติแบบเดียวกัน โดยบิดที่ชนะมีป้าย "ผู้ชนะ"

**นับผู้เข้าร่วมอย่างไรเมื่อชื่อถูกปิดบัง:** ชื่อของคนอื่นถูกแสดงเป็น `B***r` และคนละคนก็อาจได้ชื่อเดียวกัน (เช่น
Beer กับ Boer) ถ้านับจากชื่อจะได้ตัวเลขผิด ส่วนการส่ง `user_id` มาให้ก็จะทำให้รู้ได้ว่าคนเดียวกันไปบิดสินค้าชิ้นไหนบ้าง
backend จึงส่ง `bidder_key` มาให้ทั้งใน `GET /api/items/{id}/bids` และใน WebSocket `price_update` ค่านี้คือ hash ของ
(item, user) (`models.BidderKey`) คนเดียวกันในสินค้าชิ้นเดียวกันจะได้ค่าเดียวกัน แต่ข้ามสินค้าจะได้คนละค่า จึงโยงข้าม
การประมูลไม่ได้

**วิธีทดสอบ**

1. เปิดห้องประมูลที่กำลังเปิดอยู่ (เช่น demo item "Vintage Mechanical Watch") แล้วให้มีคนบิดหลายคน วิธีง่ายสุดคือเปิด
   2 browser (หนึ่งในนั้นเป็นหน้าต่าง incognito) ล็อกอินคนละบัญชี (`bidder@example.com` และบัญชีที่สมัครใหม่) แล้วผลัดกันบิด
2. ที่แท็บ "ประวัติการประมูล" ตัวเลขในวงเล็บ การ์ดสถิติ ตาราง และแผงการเสนอราคาสด ต้องอัปเดตทันทีที่อีกฝั่งบิด
   โดยไม่ต้อง refresh และบิดที่สูงสุดต้องได้อันดับ #1 พร้อมป้าย "สูงสุด"
3. พิมพ์ชื่อในช่องค้นหา ตารางต้องเหลือเฉพาะชื่อนั้น โดยเลขอันดับยังเป็นอันดับตามราคาเดิม ลองเปลี่ยนการเรียงเป็น
   "เวลา: เก่าสุดก่อน"
4. รอให้เวลาหมด หน้าจะเปลี่ยนเป็นหน้าสรุปผู้ชนะเอง ฝั่งผู้ชนะต้องขึ้นว่า "คุณชนะการประมูล!" ส่วนอีกฝั่งขึ้นว่า
   "ขอแสดงความยินดีกับผู้ชนะ" และเห็นชื่อแบบปิดบัง
5. ดู `bidder_key` จาก API (คนเดียวกันต้องได้ค่าเดียวกัน และไม่มี `user_id` ของคนอื่น):
   ```bash
   curl -s localhost:8080/api/items/<item-id>/bids
   ```

## Kafka: กลับมาเร็วหลัง restart และ 3 broker บน Kubernetes

**ทำไม Kafka ทำเป็น cluster 3 broker แต่ Redis ไม่ทำ replica/Sentinel** — ทั้งหมดรันบนเครื่องเดียว
(Docker Desktop) จึงมีความเสียหายอยู่ 2 แบบ:

| เหตุการณ์ | Redis replica + Sentinel | Kafka 3 broker |
|---|---|---|
| process ตาย (crash, OOM, kill -9) | ไม่ช่วยมาก: Redis เปิดใหม่ในไม่ถึง 1 วินาที และ AOF ไม่เสียบิดที่ตอบรับแล้ว (TC-15) การรอ Sentinel ตรวจพบและสลับ master ใช้เวลาพอ ๆ กันหรือนานกว่า | **ช่วยจริง:** broker เป็น JVM เปิดใหม่ช้า (~5–8 วินาที รวม consumer กลับเข้า group) ส่วน follower ที่มีข้อมูลครบอยู่แล้วรับช่วงเป็น leader ได้ใน ~1.5 วินาที |
| เครื่องดับ | ไม่ช่วย: replica อยู่บนเครื่องเดียวกัน ดับพร้อมกัน | ไม่ช่วยเหมือนกัน |

สรุป: บนเครื่องเดียวระบบรับประกัน**ข้อมูลไม่หาย** (AOF + reconcile จาก Postgres, Kafka acks=all,
idempotent `request_id`) แต่ถ้าเครื่องดับ**บริการหยุด**จนเครื่องกลับมา High availability จริง
(สลับไปเครื่องอื่นได้) ต้องใช้ cluster หลาย node ซึ่งอยู่ในแนวทางพัฒนาต่อของรายงาน (หัวข้อ 5.4)

**ทำไมใช้ KRaft ไม่ใช่ ZooKeeper** — Kafka แบบเก่าใช้ ZooKeeper เก็บ metadata และเลือก controller
ZooKeeper ถูก deprecate ตั้งแต่ Kafka 3.5 และถูกถอดออกใน 4.0 แทนด้วย KRaft (controller เลือกกันเองด้วย
Raft ใน process ของ Kafka) ระบบนี้ใช้ KRaft มาตั้งแต่แรก (`apache/kafka:3.7.1`) จึงไม่ต้องรัน ZooKeeper
แยก ทำให้มี process ที่ต้องดูแลน้อยลงและเลือก controller ใหม่ได้เร็วกว่า

**ขั้น A — ตัดเวลารอที่ไม่จำเป็นตอน broker restart** (TC-10 จาก 18.7 → **7.7 วินาที**) วัดแล้วพบว่า broker
พร้อมใช้ ~3.5 วินาทีหลัง start แต่เวลาที่เหลือเป็นการรอตายตัว:

| จุดที่รอ | ก่อน | หลัง |
|---|---|---|
| readiness probe ของ Kafka (K8s) | เริ่มเช็กหลัง 10 วินาที ทุก 10 วินาที ด้วยคำสั่ง JVM → Ready ที่ 14.1 วินาที | `tcpSocket` 9092 ทุก 1 วินาที |
| backoff ของ `bid-worker` ตอน fetch ล้มเหลว | สูงสุด 10 วินาที | สูงสุด 1 วินาที (`fetchBackoffMax`) |
| consumer session (รอ member id เก่าหมดอายุก่อนแจก partition) | 10 วินาที (broker บังคับขั้นต่ำ 6) | 2 วินาที + `group.min.session.timeout.ms=1000` |
| `group.initial.rebalance.delay.ms` (รอ member อื่น) | 3 วินาที | 0 (มี bid-worker ตัวเดียว) |
| producer metadata cache | 6 วินาที | 1 วินาที (`MetadataTTL`) |

**ขั้น B — Kafka 3 broker (เฉพาะ Kubernetes, `k8s/kafka.yaml`)** ทุก node เป็นทั้ง broker และ controller
replication factor 3, `min.insync.replicas=2`, producer ใช้ `acks=all` → บิดนับว่ารับแล้วเมื่อมีอย่างน้อย
2 broker เก็บไว้ เสีย broker 1 ตัวจึงไม่เสียบิด (ถ้าเสีย 2 ตัวพร้อมกัน Kafka จะปฏิเสธการเขียน ผู้บิดได้
`service_unavailable` แทนการรับบิดที่อาจหาย) และ `unclean.leader.election=false` ไม่ยก replica ที่ข้อมูล
ไม่ครบเป็น leader ตั้งให้ตรวจพบ broker ตายใน 1.5 วินาที (`broker.session.timeout.ms`, ค่าเดิม 9 วินาที)
ผล TC-16 (kill -9 broker ที่เป็น leader ของ partition ที่กำลังบิด): leader ใหม่ใน ~1.7 วินาที บิดผ่านอีกครั้ง
ใน **4–6 วินาที** (ส่วนใหญ่เป็นเวลาที่ consumer กลับเข้า group ที่ coordinator ย้ายไป broker อื่น)
ระหว่างนั้นบิดไม่ได้ถูกปฏิเสธ แค่ได้คำตอบช้าลง ไม่มีบิดหายหรือซ้ำ broker ที่ตายกลับมา sync เองใน ~20 วินาที
มีบางรอบ (1 ใน 9 รอบที่วัด) ที่ช้าถึง ~13 วินาที: log ฝั่ง broker ย้าย leader เสร็จใน ~1.6 วินาทีเหมือนเดิม
แต่ client (kafka-go) ยังพยายามต่อ broker ที่ตายจนมันกลับมา ข้อมูลยังครบทุกรอบ compose ยังเป็น broker เดียว
(ใช้ค่าของขั้น A)

**ทดสอบเอง:**
```bash
cd loadtest
```
```powershell
$env:TARGET="k8s"; node chaos/tc16_kafka_broker_failover.mjs
```
```powershell
$env:TARGET="k8s"; node chaos/tc10_kafka_restart.mjs
```
หรือด้วยมือ: ดูว่า broker ไหนเป็น leader ของแต่ละ partition แล้ว kill ตัวหนึ่งระหว่างบิดในหน้าเว็บ
```bash
kubectl -n auction exec kafka-1 -- /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --describe --topic bid-requests
```
```powershell
docker kill -s KILL (docker ps -q --filter "name=k8s_kafka_kafka-0_auction_")
```
รันคำสั่งแรกซ้ำ: partition ที่ kafka-0 (broker 1) เคยนำจะย้ายไป broker อื่น `Isr` เหลือ 2 ตัว
และกลับเป็น 3 ตัวเมื่อ kafka-0 restart เสร็จ ระหว่างนั้นบิดในหน้าเว็บยังผ่าน

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
TC-11 Postgres outage, TC-12 Redis outage, TC-13 ปิดประมูลตอนมีบิดค้างในคิว, TC-14 สินค้าถูกลบกลางการประมูล, TC-15 Redis ถูก kill -9 / ข้อมูลหาย,
TC-16 Kafka broker ตาย 1 ตัว — เฉพาะ K8s)
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
แล้วรอ ~10 วินาที ราคาจะไม่เปลี่ยนจากบิดที่ถูกปฏิเสธไป และบิดใหม่ผ่านตามปกติ

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
log ถ้ายังเป็นค่าเริ่มต้น), รหัสผ่าน Postgres/Grafana/pgAdmin, key ของ SeaweedFS (`deploy/seaweedfs/s3.json`, `k8s/seaweedfs-s3.json` และ
`S3_ACCESS_KEY`/`S3_SECRET_KEY`) และ `CORS_ORIGIN`

## Kubernetes (local)

นอกจาก compose ระบบเดียวกันรันบน Kubernetes ของ Docker Desktop ได้ด้วย (`k8s/`) โดย api-server เป็น
Deployment ที่ **HorizontalPodAutoscaler เพิ่ม/ลด pod เองตาม CPU (2–6 pod)** แทน api-1/api-2 ที่ตายตัว
และ pod ที่ตายจะถูกสร้างใหม่เอง สถาปัตยกรรมอื่นเหมือนเดิมทุกอย่าง (API server แบบ stateless, worker
แบบ single sequential consumer, broadcast ผ่าน Redis Pub/Sub, commit offset หลังเขียนสำเร็จ)

```bash
kubectl apply -k k8s
```

วิธีติดตั้ง (build image, metrics-server) วิธีดู HPA scale สด (ใน Grafana ที่ http://localhost:3000 หรือ
`kubectl`), self-healing, การรัน TC-01 ถึง TC-15 บน K8s และผลทดสอบอยู่ใน [`k8s/README.md`](k8s/README.md)

**เก็บผลลงรายงาน:** `loadtest/report/` มีสคริปต์รัน chaos test บน K8s พร้อมพิมพ์เวลาเริ่ม/จบ (ไว้ตั้งช่วงเวลาใน
Grafana) และดึงหลักฐานจาก Postgres มาแสดง เช่น
```powershell
powershell -ExecutionPolicy Bypass -File loadtest\report\run_chaos.ps1 -Script tc10_kafka_restart.mjs
```
```powershell
powershell -ExecutionPolicy Bypass -File loadtest\report\show_bids.ps1 -Title "TC-03%" -Summary
```
เพิ่ม `-KeepData` ท้ายคำสั่ง `run_chaos.ps1` ถ้าต้องการให้ข้อมูลทดสอบ (เช่น `audit_log`) ค้างไว้ดูใน pgAdmin หลังรันจบ
(ปกติ test ลบข้อมูลตัวเองตอนจบ) — ตรวจว่าใช้ได้โดยดูว่าตอนจบพิมพ์ `kept (KEEP_DATA=1): ...` แทนการลบ
รายละเอียดและคำสั่งลบข้อมูลทีหลังอยู่ใน [`loadtest/README.md`](loadtest/README.md#เก็บผลลงรายงาน-loadtestreport)

ผลสำคัญ: ยิงโหลด 300 VU ต่อเนื่อง HPA เพิ่ม api-server จาก 2 → 6 pod แล้วลดกลับเมื่อโหลดหยุด
และการ scale จริงเจอปัญหาที่ compose ไม่เคยเจอ — connection pool ของ 6 pod รวมกันเกิน
`max_connections` ของ Postgres ทำให้ request 0.22% ได้ 500 แก้แล้วด้วย `POSTGRES_MAX_CONNS`
(รายละเอียดใน `k8s/README.md`)

`POSTGRES_MAX_CONNS` (ค่าเริ่มต้น 20) คือขนาด connection pool ของแต่ละ process — ผลรวมของทุก
api-server และ bid-worker ที่รันพร้อมกันต้องไม่เกิน `max_connections` ของ Postgres (100)
