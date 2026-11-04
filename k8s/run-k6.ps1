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
          # Also pushed to the in-cluster Prometheus, so the run shows up in
          # Grafana's "k6 Load Test" and "Kubernetes Scaling" dashboards.
          args: ["run", "-o", "experimental-prometheus-rw", "/scripts/$Script"]
          env:
            - { name: BASE_URL, value: "http://frontend:8080" }
            - { name: K6_PROMETHEUS_RW_SERVER_URL, value: "http://prometheus:9090/api/v1/write" }
$extraEnv          volumeMounts:
            - { name: scripts, mountPath: /scripts }
            - { name: lib, mountPath: /scripts/lib }
      volumes:
        - { name: scripts, configMap: { name: k6-scripts } }
        - { name: lib, configMap: { name: k6-lib } }
"@ | kubectl apply -f - | Out-Null

Write-Host "k6 Job started for $Script - following its output (Ctrl+C stops following, not the Job)"
# From here on a kubectl error must not stop the script: "Stop" would also trip
# on the "no pods yet" message written to stderr while the Job is starting.
$ErrorActionPreference = "Continue"

# Wait for the pod to start. Not "kubectl wait --for=condition=Ready": a short
# script can already have finished by then, and a finished pod is never Ready.
$deadline = (Get-Date).AddSeconds(120)
do {
    Start-Sleep -Seconds 1
    $phase = kubectl -n $ns get pods -l job-name=k6 -o "jsonpath={.items[0].status.phase}" 2>$null
} until ($phase -in "Running", "Succeeded", "Failed" -or (Get-Date) -gt $deadline)

kubectl -n $ns logs -f job/k6

# Report k6's own verdict (failed thresholds), so this can be used as a test.
$deadline = (Get-Date).AddSeconds(30)
do {
    Start-Sleep -Seconds 1
    $ok = kubectl -n $ns get job k6 -o "jsonpath={.status.succeeded}" 2>$null
    $failed = kubectl -n $ns get job k6 -o "jsonpath={.status.failed}" 2>$null
} until ($ok -or $failed -or (Get-Date) -gt $deadline)
if ($ok) { Write-Host "PASS: $Script"; exit 0 }
Write-Host "FAIL: $Script"
exit 1
