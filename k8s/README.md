# รันบน Kubernetes (local)

ระบบชุดเดียวกับ `deploy/docker-compose.yml` แต่รันบน Kubernetes โดย **api-server เป็น Deployment
ที่ HorizontalPodAutoscaler (HPA) เพิ่ม/ลดจำนวน pod เองตาม CPU** (2–6 pod) แทน api-1/api-2 ที่ตายตัว
ทดสอบกับ Kubernetes ของ Docker Desktop (kubeadm, single node)

| ไฟล์ | สิ่งที่สร้าง |
|---|---|
| `postgres.yaml`, `redis.yaml`, `kafka.yaml` | StatefulSet + PersistentVolumeClaim + Service (และ Job `kafka-init` สร้าง topic 6 partition) |
| `api-server.yaml` | Deployment + Service + **HPA** (min 2, max 6, เป้า CPU 50%) |
| `bid-worker.yaml` | Deployment 1 pod เสมอ (`strategy: Recreate` — ห้ามมี worker สองตัวพร้อมกัน) |
| `frontend.yaml` + `nginx.conf` | nginx เสิร์ฟหน้าเว็บและ proxy ไป Service `api-server` เปิดเป็น LoadBalancer ที่ `localhost:8080` |
| `config.yaml` | ConfigMap/Secret ของ backend (ค่า dev เหมือน compose — ห้ามใช้กับเครื่องที่เปิดสู่ภายนอก) |
| `run-k6.ps1` | รัน k6 script เป็น Job **ภายใน cluster** |

## ต่างจาก compose ตรงไหน

- **ไม่มีรายชื่อ api-server ที่ไหนเลย** — nginx ส่งไปที่ Service `api-server` ซึ่งกระจายไปทุก pod ที่ ready
  และ pod ใหม่ได้ event เองผ่าน Redis Pub/Sub (`auction:events`)
- **pod ตายแล้วถูกสร้างใหม่อัตโนมัติ** (self-healing) readiness probe ทุก 2 วินาที ทำให้ pod ที่ตาย
  ออกจาก Service ภายใน ~2 วินาที
- **งบ connection ของ Postgres:** ทุก pod มี connection pool ของตัวเอง ผลรวมต้องไม่เกิน
  `max_connections` (100) จึงตั้ง `POSTGRES_MAX_CONNS=10` ให้ api-server: ที่ 6 pod = 60 + bid-worker 20 = 80
  (ดูหัวข้อผลทดสอบว่าทำไม)
- ทุก pod ตั้ง `enableServiceLinks: false` — ไม่งั้น Kubernetes จะใส่ env อย่าง `KAFKA_PORT` ให้ ซึ่ง image
  ของ Kafka จะเอาไปเป็น config ของ broker แล้วพัง
- `initContainers` รอ postgres/redis/kafka พร้อมก่อน (แทน `depends_on` ของ compose)

## Scale อะไรบ้าง

**scale อัตโนมัติจริงมีแค่ api-server** ส่วนอื่นเป็นจำนวนตายตัว

| Component | จำนวน pod | Scale |
|---|---|---|
| **api-server** | **2–6** ตาม CPU | ✅ HPA เพิ่ม/ลดเอง |
| bid-worker | 1 (ทั้งระบบ ไม่ใช่ต่อสินค้า) | ❌ ตั้งใจให้มีตัวเดียว |
| frontend (nginx) | 1 | ❌ ไม่มี state เพิ่ม replicas ได้ แต่ยังไม่จำเป็น |
| Postgres / Redis / Kafka | 1 | ❌ ต้องทำเป็น cluster ซึ่งเกินขอบเขตของเครื่องเดียว |

**ทำไม scale api-server:** เป็นส่วนที่ภาระโตตามจำนวนคนโดยตรง — ถือ WebSocket ของผู้ชมทุกคน, รับ REST ทั้งหมด
และส่งราคาใหม่ไปหาผู้ชมทุกคน (คนดู 10,000 คน = หนึ่งบิดต้องส่ง 10,000 ข้อความ) ช่วงที่คนแห่บิดตอนใกล้ปิด
(bid sniping) ส่วนนี้หนักก่อนส่วนอื่น

**ทำไม bid-worker มีตัวเดียว:** pod เดียวอ่านครบทั้ง 6 partition และตัดสินบิดของทุกสินค้าทีละบิด ถ้ามีสองตัว
ตัดสินสินค้าเดียวกันพร้อมกัน ทั้งคู่อาจเห็นราคาเก่าแล้วรับบิดทั้งสองอัน การตัดสินแต่ละบิดเป็นแค่คำสั่ง Redis
ไม่กี่ตัว (การเขียน Postgres ทำแบบ batch แยก) ตัวเดียวจึงไม่เป็นคอขวด (TC-01 500 VU ผ่าน) — แนวทางถ้าต้อง
scale อยู่ในหัวข้อข้อจำกัด

### api-server มีกี่ตัว

ไม่ตายตัว อยู่ระหว่าง `minReplicas: 2` ถึง `maxReplicas: 6` (ใน `api-server.yaml`)

| สถานการณ์ | จำนวน api-server |
|---|---|
| ว่าง / คนน้อย (CPU เฉลี่ยต่ำกว่า 50% ของ request 100m) | **2** |
| CPU เฉลี่ยเกิน 50% | เพิ่มได้ครั้งละ 2 pod ทุก 15 วินาที |
| โหลดหนักมาก | **6** (เพดาน) |
| โหลดลดลง | รอ 60 วินาทีให้แน่ใจ แล้วลดทีละ 1 pod ต่อ 30 วินาที จนเหลือ 2 |

**ทำไมขั้นต่ำ 2 ไม่ใช่ 1:** ถ้าตัวหนึ่งตาย อีกตัวยังรับงานต่อระหว่างที่ Kubernetes สร้างตัวใหม่ (TC-09)
และ HPA ใช้เวลาหลายวินาทีกว่าจะเพิ่ม pod (วัด CPU ทุก ~15 วินาที + pod ใหม่ต้อง start/ready) จึงต้องมี
2 ตัวรับโหลดช่วงแรกไว้ก่อน

**เพิ่มเพดานเกิน 6:** ต้องลด `POSTGRES_MAX_CONNS` ลงด้วย ไม่งั้นชนเพดาน connection ของ Postgres
(ดูหัวข้อผลทดสอบ)

### `POSTGRES_MAX_CONNS` ไม่ใช่จำนวน user ต่อ pod

ค่านี้คือจำนวน connection **จาก api-server ไปหา Postgres** ไม่ใช่จำนวน user ที่ต่อเข้ามา

```
user หลายร้อยคน ──(HTTP / WebSocket)──► api-server pod ──(pool 10 เส้น)──► Postgres
```

| | user → api-server | api-server → Postgres |
|---|---|---|
| จำนวน | ไม่มีเพดานในโค้ด ขึ้นกับ CPU/RAM ของ pod | สูงสุด `POSTGRES_MAX_CONNS` (K8s 10, compose 20) |
| ถือนานแค่ไหน | WebSocket ค้างตลอดที่เปิดหน้าเว็บ | ยืมแค่ช่วง query (ไม่กี่ ms) แล้วคืน |

connection เส้นเดียวจึงรับได้หลายร้อย request ต่อวินาที และผู้ชมที่เปิดหน้าประมูลค้างไว้ไม่ใช้ Postgres เลย
(ราคาใหม่มาทาง Redis Pub/Sub, การบิดผ่าน Kafka ไปให้ bid-worker เขียน DB) ตัวเลขจริง: HPA load test
357,050 request บน 6 pod (pool 10) ไม่ fail เลย, TC-08/09 ถือ WebSocket 100–150 เส้นโดยไม่ใช้ connection
DB เพิ่ม สิ่งที่จำกัดจำนวน user ต่อ pod จริง ๆ คือ CPU (request 100m, limit 500m) และ RAM (limit 256Mi)
— ยังไม่ได้วัดว่า 1 pod รับ WebSocket ได้สูงสุดกี่เส้น

### Kubernetes ช่วยเรื่องโหลดได้แค่ไหน

- **ไม่มี K8s (compose):** api-server 2 ตัวตายตัว คนเข้ามาเยอะแค่ไหนก็มีแค่ 2 ตัวรับ
- **มี K8s:** HPA เพิ่ม pod เมื่อ CPU เกินเป้า และลดกลับเมื่อว่าง + pod ตายแล้วสร้างใหม่เอง (ทุก component
  ไม่ใช่แค่ api-server) + nginx ไม่ต้องรู้รายชื่อ server + rolling update ได้โดยไม่หยุดระบบ

ข้อแม้ที่ควรรู้:
1. **ทุก pod อยู่บนเครื่องเดียว** — เพิ่ม pod ไม่ได้เพิ่ม CPU จริง (แบ่ง CPU ก้อนเดิม) ช่วยได้แค่ใช้หลาย core
   ได้เต็มขึ้น ความจุที่เพิ่มขึ้นจริงต้องมีหลาย node (เช่นบน cloud พร้อม cluster autoscaler) สิ่งที่การทดลองนี้
   พิสูจน์คือ **กลไก scale ทำงานถูกต้อง** — pod เพิ่ม/ลดตามโหลด, pod ใหม่ได้ event ครบ, ไม่มี request fail
2. **HPA ไม่ได้ scale ทันที** — ช่วงโหลดพุ่งกะทันหัน pod ที่มีอยู่ต้องรับไปก่อน
3. **มีเพดาน** — เกิน 6 pod ก็กลับไปหนักเหมือนเดิม
4. **scale ส่วนหนึ่ง ภาระไปตกที่ส่วนอื่น** — เจอจริงตอนเพิ่มเป็น 6 pod แล้ว Postgres connection ไม่พอ
   ส่วนที่ไม่ได้ scale (Postgres, Redis, Kafka, bid-worker) ยังเป็นเพดานของทั้งระบบ

**ทดสอบเอง:** ดูจำนวน api-server ตอนนี้ (ตอนว่างจะเป็น `cpu: 1%/50%` และ `REPLICAS 2`):
```bash
kubectl -n auction get hpa
```
ดูจำนวนเปลี่ยนแบบสด — เปิดคำสั่งนี้ค้างไว้ แล้วยิงโหลดตามหัวข้อ "ดู HPA ทำงาน" ด้านล่างในอีกหน้าต่าง:
```bash
kubectl -n auction get hpa,pods -w
```
ดูว่า connection ไป Postgres ไม่เพิ่มตามจำนวนผู้ชม (นับ connection ตอนว่าง แล้วนับใหม่ระหว่างเปิดหน้าประมูล
หลายแท็บ — ตัวเลขแทบไม่เปลี่ยน):
```bash
kubectl -n auction exec postgres-0 -- psql -U auction -d auction -c "SELECT count(*) FROM pg_stat_activity WHERE datname='auction'"
```

## วิธีรัน

**1. เปิด Kubernetes:** Docker Desktop → Settings → Kubernetes → Enable Kubernetes (เลือก **kubeadm**)
→ Apply & restart แล้วรอจนขึ้น Kubernetes running

**2. หยุด compose ก่อน** (ใช้ port 8080 เหมือนกัน และจะได้ไม่กิน RAM ซ้อน — ข้อมูลใน compose ไม่หาย):
```bash
docker compose -f deploy/docker-compose.yml stop
```

**3. Build image** (จาก root ของ repo — Kubernetes ของ Docker Desktop ใช้ image ในเครื่องได้เลย ไม่ต้อง push):
```bash
docker build -f deploy/Dockerfile.api -t auction-api:dev .
```
```bash
docker build -f deploy/Dockerfile.worker -t auction-worker:dev .
```
```bash
docker build -f deploy/Dockerfile.frontend -t auction-frontend:dev .
```

**4. ติดตั้ง metrics-server** (ครั้งแรกครั้งเดียว — HPA ต้องใช้วัด CPU; Docker Desktop ต้องเพิ่ม
`--kubelet-insecure-tls`):
```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/download/v0.7.2/components.yaml
```
```bash
kubectl -n kube-system patch deployment metrics-server --type=json -p "[{\"op\":\"add\",\"path\":\"/spec/template/spec/containers/0/args/-\",\"value\":\"--kubelet-insecure-tls\"}]"
```

**5. Deploy:**
```bash
kubectl apply -k k8s
```
รอประมาณ 1 นาที แล้วดูสถานะ:
```bash
kubectl -n auction get pods,hpa
```
ทุก pod ต้อง `Running` (ยกเว้น `kafka-init` เป็น `Completed`) และ HPA แสดง `cpu: 1%/50%` (ถ้าเป็น
`<unknown>` ให้รอ metrics-server อีกสักครู่) จากนั้นเปิด **http://localhost:8080** — บัญชี demo เหมือน
compose (`seller@example.com` / `bidder@example.com`, รหัส `password123`) แต่เป็น database ใหม่แยกจาก
compose

**หลังแก้โค้ด:** build image ใหม่ (ข้อ 3) แล้ว
```bash
kubectl -n auction rollout restart deploy/api-server deploy/bid-worker deploy/frontend
```

**ลบทั้งหมด** (รวมข้อมูลใน PVC):
```bash
kubectl delete namespace auction
```

## ทดสอบเอง

**ดู HPA ทำงาน (autoscale):** เปิด PowerShell 2 หน้าต่าง หน้าต่างแรกดูสด:
```bash
kubectl -n auction get hpa,pods -w
```
หน้าต่างที่สองยิงโหลด 300 VU ต่อเนื่อง 2 นาทีจากภายใน cluster:
```powershell
powershell -ExecutionPolicy Bypass -File k8s\run-k6.ps1 -Script hpa_autoscale_load.js
```
จะเห็น CPU พุ่งเกิน 50% แล้ว pod `api-server` เพิ่มจาก 2 → 4 → 6 ภายในไม่กี่สิบวินาที พอโหลดหยุด
pod จะค่อย ๆ ลดกลับเหลือ 2 (ทีละตัว ประมาณนาทีละตัว) ปรับได้ด้วย `-Vus 500` หรือ `-Hold 5m`

**ดู self-healing:** ดูชื่อ pod แล้วลบทิ้งหนึ่งตัว Kubernetes จะสร้างตัวใหม่มาแทนทันที:
```bash
kubectl -n auction get pods -l app=api-server
```
```bash
kubectl -n auction delete pod <ชื่อ pod จากคำสั่งบน>
```
รัน `get pods` อีกครั้งจะเห็น pod ชื่อใหม่ที่ AGE ไม่กี่วินาที ถ้าเปิดหน้าประมูลค้างไว้ หน้าเว็บที่ต่ออยู่กับ pod
ที่ถูกลบจะ reconnect เองภายในไม่กี่วินาที และราคายังถูกต้อง

**TC-08 ถึง TC-11 บน Kubernetes** (Node.js 22+):
```bash
cd loadtest
```
```powershell
$env:TARGET="k8s"; node chaos/tc08_scaleout_fanout.mjs
```
```powershell
$env:TARGET="k8s"; node chaos/tc09_api_failover.mjs
```
```powershell
$env:TARGET="k8s"; node chaos/tc10_kafka_restart.mjs
```
```powershell
$env:TARGET="k8s"; node chaos/tc11_postgres_outage.mjs
```
- TC-08: เพิ่ม `minReplicas` ของ HPA ขึ้น 1 ชั่วคราว → **HPA สร้าง pod ใหม่เอง** → ต่อเข้าแต่ละ pod ด้วย
  `kubectl port-forward` แล้วตรวจว่า pod ใหม่ได้ event ครบ → คืนค่า `minReplicas`
- TC-09: **force-delete** api-server pod ที่เก่าที่สุด (ไม่มี graceful shutdown) → ตรวจว่า viewer ที่หลุด
  ต่อใหม่ได้ราคาล่าสุด และ Kubernetes สร้าง pod มาแทนเอง
- TC-10 / TC-11: หยุด Kafka / Postgres ด้วย `kubectl scale statefulset kafka --replicas=0` (หรือ
  `postgres`) ระหว่างที่มีคนบิดอยู่ แล้วเปิดกลับด้วย `--replicas=1` ข้อมูลอยู่ใน PVC จึงไม่หาย ลองเองก็ได้
  ด้วยสองคำสั่งนี้ขณะเปิดหน้าประมูลไว้:
  ```bash
  kubectl -n auction scale statefulset postgres --replicas=0
  ```
  ```bash
  kubectl -n auction scale statefulset postgres --replicas=1
  ```

**k6 test อื่นบน Kubernetes** — script ไหนใน `loadtest/k6` ก็รันใน cluster ได้:
```powershell
powershell -ExecutionPolicy Bypass -File k8s\run-k6.ps1 -Script tc03_stress_throttling.js
```

## ผลทดสอบระหว่างพัฒนา

| Test | ผล |
|---|---|
| TC-08 (pod ที่ HPA เพิ่ม) | 150/150 viewer บน 3 pod ได้ครบ, event เฉพาะคนรั่ว 0, latency p50 30ms / p95 38ms (ผ่าน port-forward) |
| TC-09 (force-delete pod) | หลุด 33/101 connection (pod ที่ถูกลบมี 1 ใน 3), ต่อใหม่ได้ราคาล่าสุดครบ 33/33 ใน ~1.3 วินาที, บิดหลังจากนั้นถึงครบ 100/100, Kubernetes สร้าง pod แทนเอง |
| HPA autoscale (300 VU, 2 นาที) | CPU 400%+ ของ request → **2 → 4 pod ภายใน ~5 วินาที → 6 pod** ภายใน ~1 นาที; โหลดหยุดแล้วลดกลับ 6 → 2 |
| TC-10 (Kafka หยุด 10 วินาที) | บิดตอนล่มได้ `service_unavailable` 4/4, **ไม่มีตัวไหนถูกรับทีหลัง** (ก่อนแก้: 6 ตัว), บิดได้อีกครั้ง 18 วินาทีหลังเปิด Kafka (ก่อนแก้: 37 วินาที), Postgres 7/7 ไม่ซ้ำ, viewer 20/20 |
| TC-11 (Postgres หยุด 15 วินาที) | บิดระหว่างล่มผ่าน 38/38 ช้าสุด **24ms** (ก่อนแก้: 1,865ms), `bids` 44/44 และ **`audit_log` 44/44** (ก่อนแก้: 5/35), Kafka lag 0 |

**ปัญหาที่เจอจากการ scale จริง:** รอบแรกของ HPA load test มี request ล้มเหลว 0.22% (763 จาก 345,626)
เป็น HTTP 500 ทั้งหมด เกิดหลัง HPA เพิ่มเป็น 6 pod — Postgres log ขึ้น `FATAL: sorry, too many clients
already` เพราะแต่ละ pod เปิด connection pool ได้ถึง 20 (ค่าตายตัวในโค้ด): 6 × 20 + bid-worker 20 = 140 เกิน
`max_connections` 100 แก้โดยให้ตั้งขนาด pool ผ่าน `POSTGRES_MAX_CONNS` ได้ และกำหนดงบไว้ใน
`api-server.yaml` (10 ต่อ pod) รอบที่สองที่โหลดเท่ากัน: **ล้มเหลว 0 จาก 357,050 request** ปัญหานี้ไม่เคย
โผล่ใน compose เพราะมี api-server แค่ 2 ตัวตายตัว (2 × 20 + 20 = 60)

## ข้อจำกัด

- **bid-worker ยัง scale ไม่ได้** (ตั้งใจ) — ความถูกต้องของการตัดสินบิดมาจาก consumer ตัวเดียวที่ทำงานทีละบิด
  ถ้าต้อง scale ในอนาคต แนวทางคือให้ worker หลายตัวแบ่ง Kafka partition กัน (key = `item_id` จึงยังเรียงลำดับ
  ต่อ item ได้) แต่ lifecycle (เปิด/ปิดการประมูล) ต้องมี leader election ก่อน
- Postgres, Redis, Kafka เป็นตัวเดียว (ไม่มี replica) เหมือน compose
- Prometheus/Grafana/pgAdmin ยังไม่ได้ย้ายมา K8s — ใช้ `kubectl -n auction get hpa` / `kubectl top pods`
  ดู CPU และจำนวน pod แทน
- TC-06 (`tc06_worker_crash_replay.sh`) ยังใช้ `docker compose` เท่านั้น
