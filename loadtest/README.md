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

## สิ่งที่ต้องมีก่อน

- เปิด compose stack ไว้แล้ว: `cd ../deploy && docker compose up -d --build`
- ติดตั้ง [k6](https://k6.io/) (หรือใช้ `docker run --rm -i grafana/k6 run - <script.js`)
- Node.js **22 ขึ้นไป** (ใช้ `WebSocket` และ `fetch` ที่มีในตัว) สำหรับ TC-06, TC-08, TC-09
- Docker CLI ใช้งานได้จากเครื่อง (TC-06, TC-08, TC-09 สั่ง `docker compose` เพื่อ kill/เพิ่ม container
  และลบข้อมูลทดสอบ)

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

### ใช้ TC-08/TC-09 กับ Kubernetes

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
- การลบข้อมูลทดสอบใช้ `kubectl exec postgres-0` / `redis-0` แทน `docker compose exec`

สำหรับ compose เปลี่ยนคำสั่งที่ใช้เพิ่ม/ลด/kill instance ได้ด้วย env var:

| Env | ใช้กับ | ค่าเริ่มต้น |
|---|---|---|
| `API_URLS` | TC-08 | `http://localhost:8081,http://localhost:8082,http://localhost:8083` (ตัวสุดท้าย = ตัวใหม่) |
| `SCALE_UP_CMD` / `SCALE_DOWN_CMD` | TC-08 | `docker compose run ... api-1` เป็น `deploy-api-3` / `docker rm -f deploy-api-3` |
| `KILL_CMD` / `RESTORE_CMD` | TC-09 | `docker compose kill -s SIGKILL api-1` / `docker compose start api-1` |

`k6/hpa_autoscale_load.js` ไม่ใช่ TC ในรายงาน — เป็นโหลดแบบ "ทุกคนเปิดดูหน้าประมูล" ต่อเนื่อง 2 นาที ใช้โชว์
HPA บน Kubernetes (`k8s\run-k6.ps1 -Script hpa_autoscale_load.js`) ดู `k8s/README.md`

## การลบข้อมูลทดสอบ

TC-08 และ TC-09 สร้าง user (`*@chaos.local`) และสินค้าของตัวเอง แล้ว**ลบทิ้งเองตอนจบ** ทั้งใน
Postgres (`audit_log`, `bids`, `items`, `users`) และ key ใน Redis ก่อนลบจะรอให้ `bid-worker`
เขียนแถว `bids` ของสินค้านั้นลง Postgres ครบก่อน เพราะถ้าลบสินค้าขณะ batch ยังไม่ได้เขียน INSERT
จะชน foreign key แล้ว `bid-worker` จะ retry batch นั้นไม่หยุด ทำให้การเขียนครั้งต่อ ๆ ไปค้างหมด

สคริปต์ k6 แต่ละตัวสร้างสินค้า (และ user ถ้าจำเป็น) ของตัวเองใน `setup()` จึงรันซ้ำกับ stack ที่ใช้งาน
อยู่ได้โดยไม่กวนกันและไม่กวนการทดสอบผ่านหน้าเว็บ แต่**ไม่ได้ลบทิ้งเอง** ถ้าต้องการข้อมูล demo
ที่สะอาด ให้ลบสินค้าที่ชื่อขึ้นต้นด้วย `TC-0` ผ่าน pgAdmin หรือ `psql`

## อ่านผลยังไง

- k6 แสดงสรุป `checks` และบล็อก `thresholds` ของแต่ละสคริปต์ตอนจบ ถ้ามี `EXITSTATUS` ที่ไม่ใช่ 0
  (หรือบรรทัด `thresholds` สีแดง) แปลว่า test fail
- TC-02/TC-04/TC-05/TC-07 ตรวจจริงผ่าน `check()` ใน `default`/`teardown` — ถ้าต้องการรู้ว่า fail
  ตรงไหน ให้ดู console output รอบ ๆ `"exactly 1 bid was accepted"` เป็นต้น
- TC-06 เป็น bash script พิมพ์ `PASS`/`FAIL` และ exit 0/1 ตามนั้น เปิด `bid-worker` กลับให้เสมอ
- TC-08/TC-09 พิมพ์ `PASS`/`FAIL` ทีละข้อ แล้วสรุปบรรทัดสุดท้าย exit 0/1 ตามนั้น

## ปรับค่า

- env var `VUS` เปลี่ยนจำนวน virtual user ของ TC-01/03/04 (ค่าเริ่มต้น 500 / 2000 / 1000 ตรงกับ
  ตารางในรายงาน)
- `ANTI_SNIPE_WINDOW_SEC` เปลี่ยนช่วง window ที่ TC-05 สมมติไว้ ต้องตรงกับ `ANTI_SNIPE_WINDOW`
  ใน `deploy/docker-compose.yml` (ค่าเริ่มต้น 60s)
- `VIEWERS_PER_INSTANCE` (TC-08, ค่าเริ่มต้น 50) และ `VIEWERS` (TC-09, ค่าเริ่มต้น 100)

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

TC-08/TC-09 ไม่ได้ใช้ k6 จึงไม่ push เข้า Prometheus และรันแค่ไม่กี่วินาที ซึ่งสั้นกว่ารอบ scrape
5 วินาที กราฟใน Grafana จึงแทบไม่เห็น ให้ดูผลจากที่สคริปต์พิมพ์ออกมาแทน (มี latency p50/p95 ให้แล้ว)
