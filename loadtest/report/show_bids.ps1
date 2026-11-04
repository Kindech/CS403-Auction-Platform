# Prints the bids of the most recent item whose title matches -Title, straight
# from Postgres on Kubernetes - evidence for the report next to k6's summary.
# Times are Thai local time. -Summary counts bids per status/reason instead of
# listing them (for load tests with thousands of bids).
# Usage:
#   powershell -ExecutionPolicy Bypass -File loadtest\report\show_bids.ps1 -Title "TC-02%"
#   powershell -ExecutionPolicy Bypass -File loadtest\report\show_bids.ps1 -Title "TC-03%" -Summary
param(
    [Parameter(Mandatory = $true)][string]$Title,
    [switch]$Summary
)
$item = "(SELECT id FROM items WHERE title LIKE '$Title' ORDER BY created_at DESC LIMIT 1)"
if ($Summary) {
    $sql = @"
SELECT b.status, coalesce(b.reason, '') AS reason, count(*) AS bids, max(b.amount) AS highest
FROM bids b WHERE b.item_id = $item
GROUP BY 1, 2 ORDER BY 1, 2;
SELECT count(DISTINCT b.user_id) AS bidders,
       (min(b.created_at) AT TIME ZONE 'Asia/Bangkok')::time(3) AS first_bid_th,
       (max(b.created_at) AT TIME ZONE 'Asia/Bangkok')::time(3) AS last_bid_th,
       (SELECT u.display_name FROM bids w JOIN users u ON u.id = w.user_id
        WHERE w.item_id = $item AND w.status = 'accepted' ORDER BY w.amount DESC LIMIT 1) AS leader
FROM bids b WHERE b.item_id = $item;
"@
} else {
    $sql = @"
SELECT (b.created_at AT TIME ZONE 'Asia/Bangkok')::time(3) AS time_th, u.display_name AS bidder, b.amount, b.status, b.reason
FROM bids b
JOIN users u ON u.id = b.user_id
WHERE b.item_id = $item
ORDER BY b.created_at, b.id;
"@
}
kubectl -n auction exec postgres-0 -- psql -U auction -d auction -c $sql
