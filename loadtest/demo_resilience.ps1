# Resilience demo (Windows / PowerShell) - shows, step by step and with
# readable output, the guarantees the chaos tests prove:
#   0. migrations are applied automatically on startup (db.Migrate)
#   1. TC-06: killing bid-worker mid-flight loses no bids, and replayed bids
#      are recorded as accepted (bids.request_id, no "bid_too_low" replays)
#   2. nginx failover: with api-1 down, every request still succeeds via api-2
#   3. cleanup of the throwaway TC-06 item
#
# Usage (stack already running - see ../deploy):
#   powershell -ExecutionPolicy Bypass -File loadtest\demo_resilience.ps1
# Requires: Docker Desktop, Git for Windows (bash), Node.js.
$ErrorActionPreference = "Continue"
$repo    = Split-Path -Parent $PSScriptRoot
$compose = Join-Path $repo "deploy\docker-compose.yml"

$bash = "C:\Program Files\Git\bin\bash.exe"
if (-not (Test-Path $bash)) { $bash = "bash" }

function Section($t) {
    Write-Host ""
    Write-Host ("=" * 70) -ForegroundColor Cyan
    Write-Host "  $t" -ForegroundColor Cyan
    Write-Host ("=" * 70) -ForegroundColor Cyan
}
function Psql($q) { docker compose -f $compose exec -T postgres psql -U auction -d auction -c $q }
function Pause5($next) { Write-Host "Next: $next ... starting in 5s" -ForegroundColor Magenta; Start-Sleep 5 }

$testItem = "title='TC-06 Chaos Test Item'"

Section "0) Migrations applied automatically on startup (db.Migrate)"
Psql "SELECT version, applied_at FROM schema_migrations ORDER BY version;"
Pause5 "TC-06 (kill bid-worker mid-flight)"

Section "1) TC-06 Worker Crash + Replay"
Push-Location (Join-Path $repo "loadtest")
& $bash chaos/tc06_worker_crash_replay.sh
Pop-Location

Section "1b) What Postgres recorded for the TC-06 item"
Write-Host "Expect: 30 rows, all 'accepted', every one with a request_id (no bid_too_low from replay)" -ForegroundColor Yellow
Psql "SELECT b.status, coalesce(b.reason,'-') AS reason, count(*) AS rows, count(b.request_id) AS with_request_id FROM bids b JOIN items i ON i.id=b.item_id WHERE i.$testItem GROUP BY 1,2;"
Pause5 "nginx failover demo"

Section "2) nginx failover - stop api-1, keep sending requests"
docker compose -f $compose stop api-1
Write-Host "api-1 is DOWN. Sending 10 requests through nginx (localhost:8080):" -ForegroundColor Yellow
1..10 | ForEach-Object {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    try {
        $r = Invoke-WebRequest -UseBasicParsing http://localhost:8080/api/items -TimeoutSec 10
        Write-Host ("  request {0,2}: HTTP {1}  {2,5} ms" -f $_, $r.StatusCode, $sw.ElapsedMilliseconds) -ForegroundColor Green
    } catch {
        Write-Host ("  request {0,2}: FAILED  {1,5} ms" -f $_, $sw.ElapsedMilliseconds) -ForegroundColor Red
    }
}
Write-Host "(first one ~2s = proxy_connect_timeout, then nginx skips the dead replica)" -ForegroundColor Yellow
Write-Host "Bringing api-1 back..."
docker compose -f $compose start api-1 2>&1 | Out-Null

Section "3) Cleanup - deleting the TC-06 throwaway item"
Psql "BEGIN; DELETE FROM audit_log WHERE entity_id IN (SELECT id::text FROM items WHERE $testItem); DELETE FROM bids WHERE item_id IN (SELECT id FROM items WHERE $testItem); DELETE FROM items WHERE $testItem; COMMIT;"
docker compose -f $compose ps --format "{{.Service}}: {{.Status}}"
Write-Host ""
Write-Host "Demo finished." -ForegroundColor Cyan
