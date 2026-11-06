# Load & chaos tests

ชุดทดสอบนี้ทำตาม test plan ในรายงาน (ตาราง 3.1, TC-01..TC-04) และเพิ่ม test ที่พิสูจน์สิ่งที่รายงาน
กล่าวไว้ในส่วนอื่นแต่ตารางเดิมไม่มี scenario รองรับ:

| ID | ชื่อ | พิสูจน์อะไร | ประเภท |
|----|------|--------|------|
| TC-01 | Fan-out Broadcast | §3.1.1 ขั้นที่ 5 — บิดที่ผ่านหนึ่งครั้งไปถึง client ทุกคนที่เชื่อมต่ออยู่ | k6 |
| TC-02 | Race Condition (The Duel) | §3.3.2 — บิดราคาเท่ากันพร้อมกัน ต้องมีผู้ชนะคนเดียว | k6 |
| TC-03 | Stress Test & Throttling | §3.2.2 NFR — 2000 client, connection หลุด 0%, throttle ต่อ connection ทำงาน | k6 |
| TC-04 | Bid Sniping / High Concurrency | §2.3 — บิดถล่มช่วงวินาทีสุดท้าย ได้ผู้ชนะคนเดียว ระบบไม่ล่ม | k6 |
| TC-05 | Soft-Close / Anti-Sniping Extension *(เพิ่ม)* | §3.1.1 ขั้นที่ 4 — `end_time` ถูกต่อเฉพาะเมื่อบิดในช่วง anti-snipe | k6 |
| TC-06 | Worker Crash + Replay *(เพิ่ม)* | §2.6.4 — kill `bid-worker` กลาง batch แล้ว audit record ไม่หายเลย | bash + node |
| TC-07 | Reconnect Resync *(เพิ่ม)* | §3.6.3 — "ไม่ต้อง reload หน้า" reconnect แล้วได้ state ล่าสุดเสมอ | k6 |
| TC-08 | Scale-out Fan-out *(เพิ่ม)* | §2.5.9 — เพิ่ม api-server ตัวใหม่ที่ไม่มี config ไหนรู้จัก แล้วทุกตัวได้ event ครบผ่าน Redis Pub/Sub | node |
| TC-09 | API Server Failover *(เพิ่ม)* | §2.5.9 + §3.6.3 — api-server ตายกลางการประมูล ผู้ใช้ reconnect ผ่าน nginx แล้วได้ราคาล่าสุด และไม่พลาดบิดถัดไป | node |
| TC-10 | Kafka Restart *(เพิ่ม)* | §2.6.4 — Kafka หยุดแล้วกลับมา ทุกบิดได้คำตอบ, "ระบบขัดข้อง" แปลว่าไม่ถูกบันทึกจริง, ไม่มีบิดหาย/ซ้ำ | node |
| TC-11 | Postgres Outage *(เพิ่ม)* | §2.6.4 — Postgres ล่มระหว่างประมูล การบิดยัง real-time และพอกลับมา `bids` + `audit_log` ครบไม่ซ้ำ | node |
| TC-12 | Redis Outage *(เพิ่ม)* | Redis ล่มแล้วผู้บิดได้คำตอบทันที ไม่มีบิดที่ถูกปฏิเสธถูกรับทีหลัง และกลับมาบิดได้เอง | node |
| TC-13 | Close With Backlog *(เพิ่ม)* | §3.1.1 — worker ตามงานไม่ทันตอนถึงเวลาปิด บิดที่ส่งทันเวลาต้องนับทุกตัว | node |
| TC-14 | Deleted Item *(เพิ่ม)* | สินค้าถูกลบกลางการประมูล บิดของสินค้าอื่นยังบันทึกลง Postgres ได้ | node |
| TC-15 | Redis Crash *(เพิ่ม)* | Redis ถูก kill -9 แล้วไม่เสียบิดที่ตอบรับไปแล้ว และถ้า state หาย/ล้าหลัง (เครื่องดับ) `bid-worker` ซ่อมจาก Postgres ก่อนบิดถัดไป | node |

## สิ่งที่ต้องมีก่อน

- เปิด compose stack ไว้แล้ว: `cd ../deploy && docker compose up -d --build`
- ติดตั้ง [k6](https://k6.io/) (หรือใช้ `docker run --rm -i grafana/k6 run - <script.js`)
- Node.js **22 ขึ้นไป** (ใช้ `WebSocket` และ `fetch` ที่มีในตัว) สำหรับ TC-06, TC-08 ถึง TC-15
- Docker CLI ใช้งานได้จากเครื่อง (TC-06, TC-08 ถึง TC-15 สั่ง `docker compose` เพื่อ kill/เพิ่ม/หยุด
  container และลบข้อมูลทดสอบ)

ทุกสคริปต์ใช้ `BASE_URL=http://localhost:8080` (nginx) เป็นค่าเริ่มต้น เปลี่ยนได้ด้วย
`-e BASE_URL=http://your-host:8080` (k6) หรือ env var `BASE_URL` (node)

## วิธีรัน

```bash
# จากโฟลเดอร์ loadtest/
k6 run k6/tc01_fanout_broadcast.js
k6 run k6/tc02_race_condition_duel.js
k6 run k6/tc03_stress_throttling.js
k6 run k6/tc04_bid_sniping.js
k6 run k6/tc05_soft_close_extension.js   # ใช้เวลา ~90 วินาที (รอ anti-snipe จริง)
k6 run k6/tc07_reconnect_resync.js
bash chaos/tc06_worker_crash_replay.sh
node chaos/tc08_scaleout_fanout.mjs      # ~10 วินาที
node chaos/tc09_api_failover.mjs         # ~15 วินาที
node chaos/tc10_kafka_restart.mjs        # ~1 นาที (หยุด Kafka 10 วินาที แล้วรอให้กลับมา)
node chaos/tc11_postgres_outage.mjs      # ~40 วินาที (หยุด Postgres 15 วินาที)
node chaos/tc12_redis_outage.mjs         # ~30 วินาที (หยุด Redis 10 วินาที)
node chaos/tc13_close_with_backlog.mjs   # ~45 วินาที (หยุด bid-worker จนเลยเวลาปิด)
node chaos/tc14_deleted_item.mjs         # ~10 วินาที
node chaos/tc15_redis_crash.mjs          # ~30 วินาที (kill -9 Redis แล้วจำลองข้อมูลหาย)
```

หรือรันทั้งหมดด้วย `./run_all.sh` (หยุดทันทีที่ตัวไหน fail)

### Resilience demo (สำหรับนำเสนอ)

`demo_resilience.ps1` แสดงการทดสอบความทนทานทีละขั้นพร้อมสี อ่านง่าย — migration ที่ apply
อัตโนมัติ, TC-06 พร้อมแถวใน `bids` ที่ได้ (ทุกแถว `accepted` และมี `request_id`) และ nginx
failover ตอนปิด api-1 — แล้วลบ item TC-06 ที่สร้างทิ้งเอง รันในหน้าต่าง console ของตัวเองจาก root
ของ repo (ใช้เวลาประมาณ 1 นาที):

```powershell
powershell -ExecutionPolicy Bypass -File loadtest\demo_resilience.ps1
```

## TC-03 / TC-04 — ผู้บิดคนละบัญชี

TC-03 (2000 VU) และ TC-04 (1000 VU) สมัครบัญชีให้ **VU ละ 1 บัญชี** ใน `setup()` ผ่าน
`/api/auth/register` จริง ("TC03 Bidder 1..2000", "TC04 Sniper 1..1000", อีเมล `*@loadtest.local`)
แล้วรอผ่าน Prometheus ใน cluster จน api-server กลับมาที่ 2 pod และ CPU ต่ำกว่า 20% ก่อนเริ่มวัด
(`registerUsers` / `waitForBaseline` ใน `k6/lib/common.js`) เพราะ bcrypt ของการสมัครหลายพันบัญชีทำให้
HPA เพิ่ม pod ถ้าเริ่มวัดทันทีผลจะไม่ได้เริ่มจากจุดเดียวกันทุกรอบ ถ้า Prometheus ไม่อยู่ (compose) จะข้ามการรอ
หรือปิดได้ด้วย `-e PROM_URL=""`

ทั้งสองตัวนับข้อความที่ได้รับแยกประเภท (`msg_sync`, `msg_price_update`, `msg_rejected_rate_limited`,
`msg_rejected_bid_too_low`, `msg_other`) แสดงใต้ `THRESHOLDS` ผลรวมต้องเท่ากับ `ws_msgs_received`

**ปัญหาที่เจอ (แก้ใน test แล้ว):** เดิมทุก VU ใช้ `bidder@example.com` บัญชีเดียว แต่ `bid_too_low` ส่งไปทุก
connection ของเจ้าของบิด (ให้ผู้ใช้ที่เปิดหลายแท็บเห็นครบ) TC-03 จึงทำให้ 1 บิดที่ถูกปฏิเสธกลายเป็น ~2000
ข้อความ api-server ต้องทิ้งข้อความเกือบ 3 ล้านครั้งเพราะ buffer ของ client เต็ม (ระบบไม่ล่มเพราะออกแบบให้ทิ้ง
แทนการ block) ไม่ใช่สิ่งที่ผู้ใช้จริงเจอ หลังแยกบัญชี ข้อความถูกทิ้ง = 0 ดูได้จาก metric ใหม่
`auction_ws_messages_dropped_total` และ panel "WebSocket messages sent / dropped" ใน Grafana

**สิ่งที่ TC-03 เห็น (ข้อจำกัดของการออกแบบ):** throttle ยอมให้ผ่าน 10 บิด/วินาที/connection รวมได้ถึง
20,000 บิด/วินาที แต่ `bid-worker` ตัวเดียวตัดสินได้ ~1,900 บิด/วินาที บิดจึงต่อคิวใน Kafka และถูกตัดสินครบใน
~1.5 นาทีหลัง test จบ ไม่มีบิดหาย (DB ครบทุกตัว) แต่ผลของบิดที่ถูกตัดสินหลัง client ปิด connection ไปแล้วไม่มีคนรับ

## เก็บผลลงรายงาน (`loadtest/report/`)

สคริปต์ PowerShell สำหรับรัน test บน Kubernetes แล้วดึงหลักฐานไปใส่รายงาน (รันจาก root ของ repo)
เวลาทุกตัวเป็นเวลาไทย:

| สคริปต์ | ทำอะไร |
|---|---|
| `run_chaos.ps1 -Script <ไฟล์>` | รัน chaos test ใน `chaos/` ด้วย `TARGET=k8s` (`.mjs` ด้วย node, `.sh` ด้วย Git Bash) พิมพ์เวลาเริ่ม/จบไว้ตั้งช่วงเวลาใน Grafana |
| `show_bids.ps1 -Title "TC-02%"` | ตาราง `bids` ของสินค้าล่าสุดที่ชื่อตรง (เวลา, ผู้บิด, จำนวน, status, reason) |
| `show_bids.ps1 -Title "TC-03%" -Summary` | นับบิดแยก status/reason + จำนวนผู้บิด, เวลาบิดแรก/สุดท้าย, ผู้นำ (สำหรับ test ที่มีบิดหลักหมื่น) |
| `show_item.ps1 -Title "TC-05%"` | เวลาเริ่ม/จบ (เห็น `end_time` ที่ anti-snipe เลื่อน), status, ราคาจบ, ผู้ชนะ |
| `show_audit.ps1 -Title "TC-05%"` | `audit_log` ของสินค้านั้นตามลำดับเวลา |

ตัวอย่าง:
```powershell
powershell -ExecutionPolicy Bypass -File k8s\run-k6.ps1 -Script tc02_race_condition_duel.js
```
```powershell
powershell -ExecutionPolicy Bypass -File loadtest\report\show_bids.ps1 -Title "TC-02%"
```
```powershell
powershell -ExecutionPolicy Bypass -File loadtest\report\run_chaos.ps1 -Script tc06_worker_crash_replay.sh
```

ผลทั้ง 14 ตัวจากรอบเก็บผลอยู่ในตาราง "ผลทดสอบ" ของ [`k8s/README.md`](../k8s/README.md)

## TC-08 Scale-out Fan-out — ทำอะไรบ้าง

1. เปิด api-server ตัวที่ 3 (`deploy-api-3` ที่ port 8083) ด้วย `docker compose run` — ไม่มี config
   ไหนรู้จักตัวนี้ เหมือน pod ที่ HPA เพิ่มขึ้นมาเอง
2. สร้าง user ทดสอบ 3 คน (seller, alpha, beta) และสินค้า 1 ชิ้น
3. ต่อ anonymous viewer เข้า api-1, api-2, api-3 ตัวละ 50 คน (เปลี่ยนได้ด้วย `VIEWERS_PER_INSTANCE`)
   ส่วน alpha ต่อ api-3 (ตัวใหม่) และ beta ต่อ api-1
4. alpha บิด 150 จาก api-3 → beta บิด 200 จาก api-1 → alpha บิด 50 (ต่ำเกิน)
5. ตรวจว่า:
   - viewer **ทุกคนบนทุก instance** ได้ทั้ง `price_update` 150 และ 200
   - alpha (อยู่บน api-3) ได้ `outbid` และ `bid_rejected` ของตัวเอง
   - event เฉพาะคนไม่รั่วไปหาคนอื่นเลย
   - ชื่อไม่ถูกปิดสำหรับเจ้าของ (`Tc08 Alpha`) แต่ถูกปิดสำหรับคนอื่น (`T***a`)
6. แสดง latency จากตอนบิดจนถึง viewer (p50/p95/max)
7. ลบ api-3 และข้อมูลทดสอบทั้งหมด (รวมถึงตอน fail)

ผลที่ได้ระหว่างพัฒนา: 150/150 viewer ได้ครบ, 0 รั่ว, latency p50 ≈ 21ms, p95 ≈ 25ms
(304 deliveries)

## TC-09 API Server Failover — ทำอะไรบ้าง

1. สร้าง user ทดสอบ 2 คนและสินค้า 1 ชิ้น
2. ต่อ viewer 100 คน + bidder 1 คน **ผ่าน nginx** (กระจายไป api-1/api-2 แบบ round-robin) แต่ละตัว
   reconnect แบบเดียวกับ frontend (`useAuctionSocket`: รอ 1 วินาที แล้วเพิ่มเป็นสองเท่าจนถึง 10 วินาที)
3. บิด 150 → ทุกคนต้องได้
4. `docker compose kill -s SIGKILL api-1` — จำลอง process crash หรือ pod ถูกลบ
5. ตรวจว่า:
   - การ kill ทำให้ connection หลุดจริง (ไม่งั้น test ไม่ได้พิสูจน์อะไร)
   - REST ยังตอบผ่าน nginx ระหว่าง api-1 ตาย
   - ทุก connection ที่หลุด reconnect ผ่าน nginx แล้วได้ `sync` ที่ราคาปัจจุบัน (150) — ไม่มีราคาเก่าค้าง
   - บิด 200 หลัง crash ไปถึง viewer ครบทั้ง 100 คน
6. เปิด api-1 กลับ และลบข้อมูลทดสอบ (ทำเสมอ ไม่ว่าผ่านหรือไม่)

ผลที่ได้ระหว่างพัฒนา: crash ทำให้หลุด 50/101 connection, ทั้ง 50 กลับมาได้ราคาล่าสุด
(p50 ≈ 1.5s, ช้าสุด ≈ 3.5s ตาม backoff ของ frontend), บิดหลัง crash ถึงครบ 100/100 ใน ~18ms

## TC-10 Kafka Restart — ทำอะไรบ้าง

1. สร้าง user ทดสอบ 2 คนและสินค้า 1 ชิ้น ต่อ viewer 20 คน + bidder 1 คน
2. bidder บิดทีละครั้งแล้ว**รอคำตอบก่อนบิดต่อ** (เหมือนคนกดบิดแล้วดูผล) ราคาเพิ่มทีละ 10
3. บิด 3 ครั้งตอน Kafka ปกติ → **หยุด Kafka 10 วินาที** (`docker compose stop kafka` หรือ scale
   StatefulSet เป็น 0 บน K8s) ระหว่างนั้นบิดต่อ → **เปิด Kafka กลับ** แล้วบิดต่อจนผ่าน แล้วบิดอีก 3 ครั้ง
   ไม่มีการรีสตาร์ท api-server หรือ bid-worker
4. ตรวจว่า:
   - ทุกบิดได้คำตอบ (รับ หรือปฏิเสธพร้อมเหตุผล) ไม่มีบิดเงียบหาย
   - บิดตอน Kafka ล่มได้ `service_unavailable` ทุกตัว
   - **ไม่มีบิดที่ได้ `service_unavailable` ถูกรับทีหลัง** ตอน Kafka กลับมา
   - ระบบกลับมาบิดได้เอง และบิดหลังจากนั้นผ่านทั้งหมด
   - Postgres มีบิดที่รับตรงกับที่ bidder เห็นทุกตัว ไม่มี `request_id` ซ้ำ, ราคาใน Redis = บิดสุดท้าย
   - viewer ทุกคนเห็นทุกราคาที่รับ เรียงลำดับถูก
5. เปิด Kafka กลับเสมอ (แม้ fail) และลบข้อมูลทดสอบ

**ปัญหาที่ test นี้เจอ (แก้แล้ว):** รอบแรกบิด 6 ตัวที่ได้ `service_unavailable` ถูกรับทีหลังตอน Kafka
กลับมา ช้าสุด ~40 วินาที เพราะ Kafka client (kafka-go `Writer`) เก็บข้อความไว้ในคิวแล้ว retry ต่อเอง
แม้ api-server จะเลิกรอไปแล้ว ผู้ใช้ที่ถูกบอกว่าบิดไม่เข้าจึงอาจกลายเป็นผู้นำโดยไม่รู้ตัว แก้โดยให้ **broker
ปฏิเสธบิดที่มาถึงช้ากว่า 2.5 วินาที** นับจากเวลาที่บิด (`models.BidExpiry` → topic config
`message.timestamp.before.max.ms`, api-server ตั้งให้ตอน start) ซึ่งสั้นกว่าเวลาที่ api-server รอ (3 วินาที)
บิดที่ได้ `service_unavailable` จึงไม่ถูกบันทึกแน่นอน และหน้าเว็บบอกแบบนั้นได้ตรง ๆ

ปัญหาที่สองที่เจอ: หลังเปิด Kafka ต้องรอ ~37 วินาทีกว่าจะบิดได้ log ของ broker แสดงว่ามันรอ consumer
ตัวเก่าของ `bid-worker` (ก่อน restart) จน `session.timeout` 30 วินาทีหมด แล้วจึงแจก partition ให้ตัวที่
join ใหม่ ลด `SessionTimeout` ของ reader เหลือ 10 วินาที (heartbeat ทุก 3 วินาทีจึงยังห่างไกลจากเพดาน)

ผลหลังแก้: compose — บิดตอนล่มได้ `service_unavailable` 4/4, ไม่มีตัวไหนถูกรับทีหลัง, บิดได้อีกครั้ง
13.8 วินาทีหลังเปิด Kafka, Postgres 7/7 ไม่ซ้ำ, viewer 20/20 Kubernetes — ผลเหมือนกัน กลับมาใน 18.3
วินาที (pod ของ Kafka boot ช้ากว่า)

## TC-11 Postgres Outage — ทำอะไรบ้าง

1. สร้าง user ทดสอบ 2 คนและสินค้า 1 ชิ้น ต่อ viewer 20 คน + bidder 1 คน
2. bidder บิดทีละครั้งแล้วรอคำตอบ: 3 ครั้งตอนปกติ → **หยุด Postgres 15 วินาที** และบิดต่อตลอดช่วงนั้น
   → เปิด Postgres กลับ → บิดอีก 3 ครั้ง
3. ตรวจว่า:
   - ทุกบิดถูกรับ รวมทั้งตอน Postgres ล่ม และยัง **real-time** (ช้าสุดต้องไม่เกิน 1 วินาที)
   - viewer ทุกคนเห็นทุกราคา เรียงลำดับถูก
   - พอ Postgres กลับมา bid-worker เขียนบิดที่ค้างเองจน `bids` ตรงกับที่รับทุกตัว ไม่ซ้ำ
   - Kafka consumer lag กลับเป็น 0 (commit offset หลังเขียนสำเร็จ ไม่เหลืออะไรให้ replay)
   - `audit_log` มี `bid.accepted` ครบทุกบิด
4. แสดงด้วยว่า REST ที่ต้องอ่าน Postgres (`GET /api/items/{id}`) ตอบ 500 ระหว่างล่ม — เป็นข้อจำกัดที่
   คาดไว้ หน้าประมูลที่เปิดอยู่แล้วยังบิดได้ แต่ผู้ชมใหม่เปิดหน้าไม่ได้จนกว่า Postgres จะกลับ
5. เปิด Postgres กลับเสมอ และลบข้อมูลทดสอบ

**ปัญหาที่ test นี้เจอ (แก้แล้ว):**
- `audit_log` หาย 30 จาก 35 บิด — audit ของบิดเคยเขียนแบบยิงแล้วลืม (timeout 3 วินาที) แยกจาก `bids`
  ตอนนี้เขียนใน statement เดียวกับแถว `bids` (`BatchInsertBids`) จึง retry ไปด้วยกัน และไม่ซ้ำตอน replay
  เพราะเขียน audit เฉพาะเมื่อแถว `bids` ใหม่จริง
- บิดบางตัวช้า ~1.8 วินาที — lifecycle tick (เปิด/ปิดประมูล) query Postgres บน loop เดียวกับการตัดสินบิด
  พอ DB ล่ม query ค้างรอ timeout ตอนนี้ย้ายการอ่าน Postgres ไปอีก goroutine (`lifecycleLoop`) ส่วนที่
  แตะ state ใน Redis ยังอยู่บน loop เดิม การปิดประมูลจึงยังไม่ชนกับการตัดสินบิด

ยังไม่ครอบคลุม: ถ้ามีบิดช่วง anti-snipe ระหว่าง Postgres ล่ม `end_time` ใหม่จะอยู่ใน Redis (ซึ่งเป็นตัวที่
ใช้ตัดสินจริง) แต่การบันทึกลง `items.end_time` ยังเป็นแบบยิงแล้วลืมและจะหายไป และการปิดประมูลที่ถึงเวลา
ระหว่างล่มจะเลื่อนไปทำตอน Postgres กลับมา (บิดหลังเวลาปิดถูกปฏิเสธตามปกติเพราะตัดสินจาก Redis)

ผลหลังแก้: compose — บิดระหว่างล่มผ่าน 38/38 p50 15ms ช้าสุด 18ms (เท่าตอนปกติ), เขียนบิดที่ค้าง
ครบ 10 วินาทีหลังเปิด Postgres (`writeLoop` retry แบบ backoff สูงสุด 10 วินาที), `bids` 44/44,
`audit_log` 44/44, Kafka lag 0 Kubernetes — ผลเหมือนกัน ช้าสุด 24ms

## TC-12 Redis Outage — ทำอะไรบ้าง

1. สร้าง user ทดสอบ 2 คนและสินค้า 1 ชิ้น ต่อ viewer 20 คน + bidder 1 คน
2. บิดตอนปกติ → **หยุด Redis 10 วินาที** ระหว่างนั้นบิดต่อ → เปิดกลับ แล้วบิดจนผ่าน
3. ตรวจว่า:
   - บิดตอนล่มได้ `service_unavailable` ทุกตัว และตอบภายใน 2 วินาที
   - ไม่มีบิดที่ถูกปฏิเสธถูกรับทีหลัง ราคาใน Redis = บิดสุดท้ายที่รับ
   - ระบบกลับมาบิดได้เอง และ viewer ทุกคนได้ราคาสดอีกครั้ง (api-server subscribe ใหม่เอง)
4. เปิด Redis กลับเสมอ และลบข้อมูลทดสอบ

**ปัญหาที่ test นี้เจอ (แก้แล้ว):** ผู้บิดไม่ได้ยินอะไรเลยตลอดช่วงที่ Redis ล่ม (ลองแล้ว 30 วินาที) เพราะ `bid-worker`
ต้องใช้ Redis ทั้งตัดสินและแจ้งผล ตอนนี้ api-server เช็ก Redis อยู่ตลอดและตอบเองทันที การแก้รอบแรก
(ping ก่อนส่งทุกบิด) ยังตอบช้า ~7 วินาทีเพราะการ dial Redis ที่ปิดอยู่ค้างนาน จึงเปลี่ยนเป็นเช็กแยกใน background

ข้อจำกัด: ช่วง ~2.5 วินาทีแรกที่ยังตรวจไม่พบ บิดที่เข้า Kafka ไปแล้วจะถูกบันทึกเป็น `internal_error` หรือรับตอน
Redis กลับมา ขึ้นกับจังหวะ โดยผู้บิดอาจไม่ได้คำตอบ เพราะช่องทางแจ้งผลก็คือ Redis เอง

## TC-15 Redis Crash — ทำอะไรบ้าง

TC-12 หยุด Redis แบบปกติ (Redis ได้ save ก่อนออก) test นี้ฆ่าแบบไม่ให้ตั้งตัว แล้วไปไกลกว่าที่การฆ่าทำได้

1. สร้าง user ทดสอบ 3 คน (ผู้ขาย + ผู้บิด 2 คนบิดสลับกัน) และสินค้า 1 ชิ้น ต่อ viewer 10 คน
2. **kill -9:** บิดแล้ว **ส่ง SIGKILL ให้ Redis ทันทีหลังได้คำตอบ** (compose: `docker compose kill -s SIGKILL`,
   K8s: `docker kill -s KILL` ที่ container ของ `redis-0` — `kubectl delete pod` ใช้ไม่ได้เพราะ kubelet ส่ง SIGTERM
   ก่อนและ Redis จะ save เรียบร้อย) ตรวจว่า exit code = 137, Redis กลับมายังมีบิดล่าสุด และบิดต่อได้เอง
3. **AOF วินาทีสุดท้ายหาย (เครื่องดับ) — จำลอง:** การฆ่า process ไม่ทำให้ข้อมูลหาย เพราะ Redis ส่งทุกคำสั่งให้ OS
   ก่อนตอบ แต่ถ้าเครื่องดับ OS จะยังไม่ได้เขียนวินาทีสุดท้ายลงดิสก์ test จึงย้อน state ใน Redis ไปเป็นบิดก่อนหน้า
   (คนละผู้นำ ราคาต่ำกว่า) เหมือนข้อมูลหายจริง แล้วตรวจว่า `bid-worker` คืนราคาและผู้นำจาก Postgres และบิดที่
   "สูงพอสำหรับ state เก่าแต่ไม่พอสำหรับราคาจริง" ถูกปฏิเสธเป็น `bid_too_low`
4. **state หายทั้ง key:** ลบ key ทิ้ง ตรวจว่า `bid-worker` สร้างกลับมาด้วยราคาและผู้นำจริง แล้วบิดต่อได้
5. ตรวจว่า Postgres มีบิด accepted ตรงกับที่ผู้บิดเห็น ไม่ซ้ำ และ viewer ทุกคนเห็นราคาสุดท้าย แล้วลบข้อมูลทดสอบ

ผลบน Kubernetes (7 พ.ย. 2026): exit code 137, ไม่มีบิดหาย (ราคาหลัง kill = บิดสุดท้าย), บิดได้อีกครั้ง 0.8–1.9 วินาที
หลัง Redis ตอบ, ซ่อม state ที่ล้าหลังใน 0.7–1.0 วินาที, สร้าง key ที่หายใหม่ใน 0.4 วินาที, Postgres 7/7 ไม่ซ้ำ

## TC-13 Close With Backlog — ทำอะไรบ้าง

1. สร้างสินค้า 8 ชิ้นที่จบใน 25 วินาที และอีก 1 ชิ้นที่ไม่มีคนบิด
2. **หยุด `bid-worker`** แล้วบิดทุกชิ้นก่อนเวลาจบ บิดจึงค้างอยู่ใน Kafka
3. รอจนเลยเวลาจบ แล้วเปิด `bid-worker` กลับ
4. ตรวจว่า:
   - บิดทั้ง 8 ถูกรับ ไม่มีตัวไหนถูกปฏิเสธ (Postgres ตรงกัน)
   - ไม่มีการประมูลไหนจบ เพราะบิดทุกตัวอยู่ในช่วง anti-snipe จึงต่อเวลาแทน
   - สินค้าที่ไม่มีคนบิดยังปิดตามปกติ
5. เปิด `bid-worker` กลับเสมอ และลบข้อมูลทดสอบ

**ปัญหาที่ test นี้เจอ (แก้แล้ว):** การปิดประมูลเคยตัดสินจากนาฬิกาอย่างเดียว ไม่ได้ดูว่ามีบิดค้างในคิวหรือไม่ ทดสอบแบบ
เดียวกัน 6 จาก 8 บิดที่ส่ง 7 วินาทีก่อนเวลาปิดถูกปฏิเสธเป็น `auction_not_live` และสินค้าจบแบบไม่มีผู้ชนะ ตอนนี้ปิดผ่าน
close marker ที่อยู่ใน Kafka partition เดียวกับบิด ซึ่งต้องอ่านบิดก่อนหน้าครบก่อนเสมอ

## TC-14 Deleted Item — ทำอะไรบ้าง

1. สร้างสินค้า 2 ชิ้น ต่อ bidder เข้าทั้งคู่ แล้ว**ลบชิ้นหนึ่งออกจาก Postgres ตรง ๆ** (เหมือนลบใน pgAdmin)
2. บิดทั้งสองชิ้น
3. ตรวจว่า:
   - บิดของสินค้าอีกชิ้นถูกบันทึกลง Postgres และ Kafka lag กลับเป็น 0
   - บิดที่บันทึกไม่ได้มีหลักฐานใน `audit_log` (`bid.dropped`)
   - สินค้าที่ถูกลบไม่รับบิดอีก (`auction_not_live`)
4. ลบข้อมูลทดสอบ

**ปัญหาที่ test นี้เจอ (แก้แล้ว):** INSERT ชน foreign key แล้ว `bid-worker` retry batch นั้นไม่หยุด ทำให้บิดของ
**ทุกสินค้า** ไม่ถูกบันทึกอีกเลย แม้ restart worker ก็ไม่หาย เพราะ Kafka ส่ง batch เดิมซ้ำ

### ใช้ TC-06, TC-08 ถึง TC-15 กับ Kubernetes

ตั้ง `TARGET=k8s` แล้วสคริปต์จะทำงานกับ deployment ใน `k8s/` (namespace `auction`) แทน compose:

```powershell
$env:TARGET="k8s"; node chaos/tc08_scaleout_fanout.mjs
```
```powershell
$env:TARGET="k8s"; node chaos/tc09_api_failover.mjs
```

- TC-08: ให้ **HPA สร้าง pod ใหม่เอง** (เพิ่ม `minReplicas` ขึ้น 1 ชั่วคราว) แล้วต่อเข้าแต่ละ pod ผ่าน
  `kubectl port-forward` (port 18081, 18082, ...) จบแล้วคืนค่า `minReplicas`
- TC-09: force-delete api-server pod ที่เก่าที่สุด แล้วตรวจเพิ่มว่า Kubernetes สร้าง pod มาแทนเอง
- TC-06: force-delete pod ของ `bid-worker` แล้วให้ Kubernetes สร้างตัวใหม่เอง
- TC-10 / TC-11 / TC-12: หยุด Kafka / Postgres / Redis ด้วย `kubectl scale statefulset <ชื่อ> --replicas=0`
  แล้วเปิดกลับด้วย `--replicas=1` (ข้อมูลอยู่ใน PVC ไม่หาย)
- TC-13: หยุด `bid-worker` ด้วย `kubectl scale deployment bid-worker --replicas=0`
- การลบข้อมูลทดสอบใช้ `kubectl exec postgres-0` / `redis-0` แทน `docker compose exec`

สำหรับ compose เปลี่ยนคำสั่งที่ใช้เพิ่ม/ลด/kill instance ได้ด้วย env var:

| Env | ใช้กับ | ค่าเริ่มต้น |
|---|---|---|
| `API_URLS` | TC-08 | `http://localhost:8081,http://localhost:8082,http://localhost:8083` (ตัวสุดท้าย = ตัวใหม่) |
| `HOLD_MS` | TC-08, TC-09 | ถือ connection ไว้ให้ Prometheus/Grafana เห็น (test จริงสั้นกว่ารอบ scrape 5s): K8s 20000 ms (TC-08) / 15000 ms ก่อนและหลัง crash (TC-09), compose 0 |
| `SCALE_UP_CMD` / `SCALE_DOWN_CMD` | TC-08 | `docker compose run ... api-1` เป็น `deploy-api-3` / `docker rm -f deploy-api-3` |
| `KILL_CMD` / `RESTORE_CMD` | TC-09 | `docker compose kill -s SIGKILL api-1` / `docker compose start api-1` |
| `STOP_CMD` / `START_CMD` | TC-10, TC-11, TC-12 | `docker compose stop kafka` / `docker compose start kafka` (TC-11: `postgres`, TC-12: `redis`) |
| `DOWN_MS` | TC-10, TC-11, TC-12 | ระยะที่หยุด service: 10000 / 15000 / 10000 ms |

`k6/hpa_autoscale_load.js` ไม่ใช่ TC ในรายงาน — เป็นโหลดแบบ "ทุกคนเปิดดูหน้าประมูล" ต่อเนื่อง 2 นาที ใช้โชว์
HPA บน Kubernetes (`k8s\run-k6.ps1 -Script hpa_autoscale_load.js`) ดู `k8s/README.md`

## การลบข้อมูลทดสอบ

TC-08 ถึง TC-15 สร้าง user (`*@chaos.local`) และสินค้าของตัวเอง แล้ว**ลบทิ้งเองตอนจบ** ทั้งใน
Postgres (`audit_log`, `bids`, `items`, `users`) และ key ใน Redis ก่อนลบจะรอให้ `bid-worker`
เขียนแถว `bids` ของสินค้านั้นลง Postgres ครบก่อน เพื่อไม่ให้เหลือแถว `bid.dropped` ค้างใน `audit_log`

สคริปต์ k6 แต่ละตัวสร้างสินค้า (และ user ถ้าจำเป็น) ของตัวเองใน `setup()` จึงรันซ้ำกับ stack ที่ใช้งาน
อยู่ได้โดยไม่กวนกันและไม่กวนการทดสอบผ่านหน้าเว็บ แต่**ไม่ได้ลบทิ้งเอง** (เก็บไว้เป็นหลักฐาน) ถ้าต้องการข้อมูล
demo ที่สะอาด ให้ลบสินค้าที่ชื่อขึ้นต้นด้วย `TC-0` และบัญชี `*@loadtest.local` (TC-03 สร้างรอบละ 2000,
TC-04 รอบละ 1000) ผ่าน pgAdmin หรือ `psql` นับบัญชีที่มีอยู่ได้ด้วย:
```sql
SELECT split_part(display_name, ' ', 1) || ' ' || split_part(display_name, ' ', 2) AS account_group, count(*)
FROM users WHERE email LIKE '%@loadtest.local' GROUP BY 1;
```

## อ่านผลยังไง

- k6 แสดงสรุป `checks` และบล็อก `thresholds` ของแต่ละสคริปต์ตอนจบ ถ้ามี `EXITSTATUS` ที่ไม่ใช่ 0
  (หรือบรรทัด `thresholds` สีแดง) แปลว่า test fail
- TC-02/TC-04/TC-05/TC-07 ตรวจจริงผ่าน `check()` ใน `default`/`teardown` — ถ้าต้องการรู้ว่า fail
  ตรงไหน ให้ดู console output รอบ ๆ `"exactly 1 bid was accepted"` เป็นต้น
- TC-06 เป็น bash script พิมพ์ `PASS`/`FAIL` และ exit 0/1 ตามนั้น เปิด `bid-worker` กลับให้เสมอ
- TC-08 ถึง TC-15 พิมพ์ `PASS`/`FAIL` ทีละข้อ แล้วสรุปบรรทัดสุดท้าย exit 0/1 ตามนั้น
- `k8s\run-k6.ps1` พิมพ์ `PASS`/`FAIL` และ exit 0/1 ตามผลของ k6

## ปรับค่า

- env var `VUS` เปลี่ยนจำนวน virtual user ของ TC-01/03/04 (ค่าเริ่มต้น 500 / 2000 / 1000 ตรงกับ
  ตารางในรายงาน)
- `ANTI_SNIPE_WINDOW_SEC` เปลี่ยนช่วง window ที่ TC-05 สมมติไว้ ต้องตรงกับ `ANTI_SNIPE_WINDOW`
  ใน `deploy/docker-compose.yml` (ค่าเริ่มต้น 60s)
- `VIEWERS_PER_INSTANCE` (TC-08, ค่าเริ่มต้น 50) และ `VIEWERS` (TC-09 ค่าเริ่มต้น 100, TC-10/TC-11
  ค่าเริ่มต้น 20)

## ดูผลใน Grafana

compose stack (ดูหัวข้อ Observability ใน README หลัก) เปิด Prometheus ด้วย
`--web.enable-remote-write-receiver` ไว้แล้ว สคริปต์ k6 ตัวไหนก็ push metric เข้า Prometheus ได้เลย
แทนที่จะพิมพ์สรุปใน terminal อย่างเดียว:

```bash
K6_PROMETHEUS_RW_SERVER_URL="http://localhost:9090/api/v1/write" \
  k6 run -o experimental-prometheus-rw k6/tc01_fanout_broadcast.js
```

จากนั้นเปิด Grafana (`http://localhost:3000`, `admin`/`admin`) → **Auction - k6 Load Test** เพื่อดู
VUs, request rate, p99 duration และ check pass rate แบบสดระหว่างรัน หรือดูย้อนหลังโดยขยายช่วงเวลา
ให้ครอบช่วงที่รัน ตรวจสอบแล้วระหว่างพัฒนาด้วย TC-01 ที่ 200 VUs: `k6_vus_max`,
`k6_ws_sessions_total` และ `k6_checks_rate` ใน Prometheus ตรงกับสรุปใน terminal ทุกค่า

บน Kubernetes `k8s\run-k6.ps1` push metric ของ k6 เข้า Prometheus ใน cluster ให้อัตโนมัติ เปิด Grafana
ที่ `http://localhost:3000` ได้เลย (ดู `k8s/README.md`)

TC-08/TC-09 ไม่ได้ใช้ k6 และตัว test รันแค่ 2–4 วินาที สั้นกว่ารอบ scrape 5 วินาที บน Kubernetes
จึงถือ connection ไว้เพิ่ม (`HOLD_MS`) ให้ panel "WebSocket connections per pod" เห็น: TC-08 เห็น 3 pod รวม pod
ที่ HPA เพิ่ม (ค่าใกล้กันมากจนเส้นทับกัน ให้ hover ดู tooltip) และพิมพ์จำนวนจาก `/metrics` ของแต่ละ pod ให้ด้วย
TC-09 เห็น connection ย้ายจาก pod ที่ถูกลบไป pod ที่เหลือ (เช่น 48/53 → 0/101) panel WebSocket และ k6 VUs แสดง
ค่าสูงสุดในแต่ละช่วง (`max_over_time`) จึงไม่พลาด spike สั้น ๆ แม้ตั้งช่วงเวลากว้าง TC-10 ถึง TC-14 พิมพ์ผลของทุกบิด
ออกมาให้แล้ว ใช้ผลจาก terminal เป็นหลัก
