# Prints the most recent item whose title matches -Title: its times (Thai local
# time), status and result, straight from Postgres on Kubernetes. For TC-05
# this shows the end time the anti-snipe extension moved.
# Usage: powershell -ExecutionPolicy Bypass -File loadtest\report\show_item.ps1 -Title "TC-05%"
param([Parameter(Mandatory = $true)][string]$Title)
$sql = @"
SELECT i.title,
       (i.start_time AT TIME ZONE 'Asia/Bangkok')::time(3) AS start_th,
       (i.end_time AT TIME ZONE 'Asia/Bangkok')::time(3) AS end_th,
       i.status, i.final_price, u.display_name AS winner
FROM items i LEFT JOIN users u ON u.id = i.winner_id
WHERE i.id = (SELECT id FROM items WHERE title LIKE '$Title' ORDER BY created_at DESC LIMIT 1);
"@
kubectl -n auction exec postgres-0 -- psql -U auction -d auction -c $sql
