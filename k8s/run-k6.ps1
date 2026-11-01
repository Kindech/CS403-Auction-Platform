# Runs one k6 script from loadtest/k6 as a Job inside the cluster, so load
# goes pod-to-pod (k6 -> frontend Service -> api-server pods) and never
# through Docker Desktop's host port-forwarding, which caps out at a few
# hundred WebSockets on Windows.
#
# Usage (from the repo root):
#   powershell -ExecutionPolicy Bypass -File k8s\run-k6.ps1 -Script hpa_autoscale_load.js
#   powershell -ExecutionPolicy Bypass -File k8s\run-k6.ps1 -Script tc03_stress_throttling.js -Vus 2000
param(
    [Parameter(Mandatory = $true)][string]$Script,
    [int]$Vus = 0,
    [string]$Hold = ""
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$ns = "auction"

# Scripts and their shared lib as ConfigMaps (recreated so edits are picked up).
kubectl -n $ns delete configmap k6-scripts k6-lib --ignore-not-found | Out-Null
kubectl -n $ns create configmap k6-scripts --from-file="$root\loadtest\k6" | Out-Null
kubectl -n $ns create configmap k6-lib --from-file="$root\loadtest\k6\lib" | Out-Null
kubectl -n $ns delete job k6 --ignore-not-found | Out-Null

$extraEnv = ""
if ($Vus -gt 0) { $extraEnv += "            - { name: VUS, value: `"$Vus`" }`n" }
if ($Hold) { $extraEnv += "            - { name: HOLD, value: `"$Hold`" }`n" }

@"
apiVersion: batch/v1
kind: Job
metadata:
  name: k6
  namespace: $ns
spec:
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
      enableServiceLinks: false
      containers:
        - name: k6
          image: grafana/k6:2.1.0
          args: ["run", "/scripts/$Script"]
          env:
            - { name: BASE_URL, value: "http://frontend:8080" }
$extraEnv          volumeMounts:
            - { name: scripts, mountPath: /scripts }
            - { name: lib, mountPath: /scripts/lib }
      volumes:
        - { name: scripts, configMap: { name: k6-scripts } }
        - { name: lib, configMap: { name: k6-lib } }
"@ | kubectl apply -f - | Out-Null

Write-Host "k6 Job started for $Script - following its output (Ctrl+C stops following, not the Job)"
kubectl -n $ns wait --for=condition=Ready pod -l job-name=k6 --timeout=120s | Out-Null
kubectl -n $ns logs -f job/k6
