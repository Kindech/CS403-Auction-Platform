# Prints the audit_log of the most recent item whose title matches -Title
# (Thai local time): created, every bid decision, and how it ended.
# Usage: powershell -ExecutionPolicy Bypass -File loadtest\report\show_audit.ps1 -Title "TC-05%"
param([Parameter(Mandatory = $true)][string]$Title)
$sql = @"
SELECT (a.created_at AT TIME ZONE 'Asia/Bangkok')::time(3) AS time_th, a.action, u.display_name AS by_user, a.details
FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
WHERE a.entity_id = (SELECT id::text FROM items WHERE title LIKE '$Title' ORDER BY created_at DESC LIMIT 1)
ORDER BY a.created_at, a.id;
"@
kubectl -n auction exec postgres-0 -- psql -U auction -d auction -c $sql
