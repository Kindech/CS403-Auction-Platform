# Runs one chaos test (loadtest/chaos) against Kubernetes and prints when it
# started and ended (Thai local time), to line it up with Grafana.
# Usage: powershell -ExecutionPolicy Bypass -File loadtest\report\run_chaos.ps1 -Script tc06_worker_crash_replay.sh
#        powershell -ExecutionPolicy Bypass -File loadtest\report\run_chaos.ps1 -Script tc08_scaleout_fanout.mjs
param([Parameter(Mandatory = $true)][string]$Script)
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$path = Join-Path $root "loadtest\chaos\$Script"
$env:TARGET = "k8s"
Write-Host "started $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
if ($Script.EndsWith(".sh")) {
    $bash = "C:\Program Files\Git\bin\bash.exe"
    if (-not (Test-Path $bash)) { $bash = "bash" }
    & $bash $path
} else {
    node $path
}
$code = $LASTEXITCODE
Write-Host "ended   $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') (exit code $code)"
exit $code
