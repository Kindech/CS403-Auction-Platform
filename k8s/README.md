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

**TC-08 / TC-09 บน Kubernetes** (Node.js 22+):
```bash
cd loadtest
```
```powershell
$env:TARGET="k8s"; node chaos/tc08_scaleout_fanout.mjs
```
```powershell
$env:TARGET="k8s"; node chaos/tc09_api_failover.mjs
```
- TC-08: เพิ่ม `minReplicas` ของ HPA ขึ้น 1 ชั่วคราว → **HPA สร้าง pod ใหม่เอง** → ต่อเข้าแต่ละ pod ด้วย
  `kubectl port-forward` แล้วตรวจว่า pod ใหม่ได้ event ครบ → คืนค่า `minReplicas`
- TC-09: **force-delete** api-server pod ที่เก่าที่สุด (ไม่มี graceful shutdown) → ตรวจว่า viewer ที่หลุด
  ต่อใหม่ได้ราคาล่าสุด และ Kubernetes สร้าง pod มาแทนเอง

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
