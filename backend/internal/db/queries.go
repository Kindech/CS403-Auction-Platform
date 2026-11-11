package db

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"auction/backend/internal/models"
)

var ErrNotFound = errors.New("not found")

// ---- users ----

func CreateUser(ctx context.Context, pool *pgxpool.Pool, email, passwordHash, displayName string) (models.User, error) {
	var u models.User
	err := pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name) VALUES ($1,$2,$3)
		 RETURNING id, email, password_hash, display_name, created_at`,
		email, passwordHash, displayName,
	).Scan(&u.ID, &u.Email, &u.PasswordHash, &u.DisplayName, &u.CreatedAt)
	return u, err
}

func GetUserByEmail(ctx context.Context, pool *pgxpool.Pool, email string) (models.User, error) {
	var u models.User
	err := pool.QueryRow(ctx,
		`SELECT id, email, password_hash, display_name, created_at, failed_login_attempts, locked_until
		 FROM users WHERE email=$1`,
		email,
	).Scan(&u.ID, &u.Email, &u.PasswordHash, &u.DisplayName, &u.CreatedAt, &u.FailedLoginAttempts, &u.LockedUntil)
	if errors.Is(err, pgx.ErrNoRows) {
		return u, ErrNotFound
	}
	return u, err
}

// ClaimLoginAttempt spends one of the account's login attempts, and is called
// before the password is checked. The account's row is locked by the UPDATE
// and the WHERE clause is re-checked against the newest row version, so no
// matter how many requests arrive at once, at most maxAttempts passwords get
// checked before the lock. allowed is false if the account is locked;
// justLocked means this attempt was the last one (a correct password still
// clears it, through ResetFailedLogins).
//
// Counting after the password check instead let parallel guesses all pass the
// lock check first: 40 at once were all evaluated despite a limit of 5, and a
// CTE-based increment lost updates on top of that.
func ClaimLoginAttempt(ctx context.Context, pool *pgxpool.Pool, userID string, maxAttempts int, lockoutDuration time.Duration) (allowed, justLocked bool, err error) {
	err = pool.QueryRow(ctx, `
		UPDATE users
		SET failed_login_attempts = CASE WHEN failed_login_attempts + 1 >= $2 THEN 0 ELSE failed_login_attempts + 1 END,
		    locked_until = CASE WHEN failed_login_attempts + 1 >= $2 THEN now() + make_interval(secs => $3) ELSE locked_until END
		WHERE id = $1 AND (locked_until IS NULL OR locked_until <= now())
		RETURNING locked_until IS NOT NULL AND locked_until > now()`,
		userID, maxAttempts, lockoutDuration.Seconds(),
	).Scan(&justLocked)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, false, nil
	}
	return err == nil, justLocked, err
}

// ResetFailedLogins clears the failed-attempt counter and any active lock -
// called after a successful login.
func ResetFailedLogins(ctx context.Context, pool *pgxpool.Pool, userID string) error {
	_, err := pool.Exec(ctx,
		`UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1`,
		userID,
	)
	return err
}

func GetUserByID(ctx context.Context, pool *pgxpool.Pool, id string) (models.User, error) {
	var u models.User
	err := pool.QueryRow(ctx,
		`SELECT id, email, password_hash, display_name, created_at FROM users WHERE id=$1`,
		id,
	).Scan(&u.ID, &u.Email, &u.PasswordHash, &u.DisplayName, &u.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return u, ErrNotFound
	}
	return u, err
}

// ---- items ----

func CreateItem(ctx context.Context, pool *pgxpool.Pool, it models.Item) (models.Item, error) {
	status := models.ItemUpcoming
	if !it.StartTime.After(time.Now()) {
		status = models.ItemLive
	}
	err := pool.QueryRow(ctx,
		`INSERT INTO items (seller_id, title, description, image_url, image_urls, starting_price, bid_increment, start_time, end_time, status)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
		 RETURNING id, created_at, status`,
		it.SellerID, it.Title, it.Description, it.ImageURL, it.ImageURLs, it.StartingPrice, it.BidIncrement, it.StartTime, it.EndTime, status,
	).Scan(&it.ID, &it.CreatedAt, &it.Status)
	it.CurrentPrice = it.StartingPrice
	return it, err
}

const itemSelectCols = `
	i.id, i.seller_id, u.display_name, i.title, i.description, i.image_url, i.image_urls,
	i.starting_price, i.bid_increment, i.start_time, i.end_time, i.status,
	i.winner_id, w.display_name, i.final_price, i.created_at`

func scanItem(row pgx.Row) (models.Item, error) {
	var it models.Item
	var winnerID, winnerName *string
	var finalPrice *float64
	err := row.Scan(
		&it.ID, &it.SellerID, &it.SellerName, &it.Title, &it.Description, &it.ImageURL, &it.ImageURLs,
		&it.StartingPrice, &it.BidIncrement, &it.StartTime, &it.EndTime, &it.Status,
		&winnerID, &winnerName, &finalPrice, &it.CreatedAt,
	)
	it.WinnerID = winnerID
	it.WinnerName = winnerName
	it.FinalPrice = finalPrice
	it.CurrentPrice = it.StartingPrice
	if finalPrice != nil {
		it.CurrentPrice = *finalPrice
	}
	return it, err
}

func ListItems(ctx context.Context, pool *pgxpool.Pool) ([]models.Item, error) {
	rows, err := pool.Query(ctx, `
		SELECT `+itemSelectCols+`
		FROM items i
		JOIN users u ON u.id = i.seller_id
		LEFT JOIN users w ON w.id = i.winner_id
		ORDER BY i.created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []models.Item{}
	for rows.Next() {
		it, err := scanItem(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, it)
	}
	return out, rows.Err()
}

func ListItemsBySeller(ctx context.Context, pool *pgxpool.Pool, sellerID string) ([]models.Item, error) {
	rows, err := pool.Query(ctx, `
		SELECT `+itemSelectCols+`
		FROM items i
		JOIN users u ON u.id = i.seller_id
		LEFT JOIN users w ON w.id = i.winner_id
		WHERE i.seller_id = $1
		ORDER BY i.created_at DESC`, sellerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []models.Item{}
	for rows.Next() {
		it, err := scanItem(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, it)
	}
	return out, rows.Err()
}

func GetItem(ctx context.Context, pool *pgxpool.Pool, id string) (models.Item, error) {
	if !models.IsUUID(id) {
		return models.Item{}, ErrNotFound
	}
	row := pool.QueryRow(ctx, `
		SELECT `+itemSelectCols+`
		FROM items i
		JOIN users u ON u.id = i.seller_id
		LEFT JOIN users w ON w.id = i.winner_id
		WHERE i.id = $1`, id)
	it, err := scanItem(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return it, ErrNotFound
	}
	return it, err
}

func ActivateDueItems(ctx context.Context, pool *pgxpool.Pool) ([]models.Item, error) {
	rows, err := pool.Query(ctx, `
		UPDATE items SET status = 'live'
		WHERE status = 'upcoming' AND start_time <= now()
		RETURNING id, starting_price, bid_increment, end_time`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []models.Item{}
	for rows.Next() {
		var it models.Item
		if err := rows.Scan(&it.ID, &it.StartingPrice, &it.BidIncrement, &it.EndTime); err != nil {
			return nil, err
		}
		out = append(out, it)
	}
	return out, rows.Err()
}

func FinalizeItem(ctx context.Context, pool *pgxpool.Pool, itemID string, winnerID *string, finalPrice *float64) error {
	_, err := pool.Exec(ctx, `
		UPDATE items SET status = 'ended', winner_id = $2, final_price = $3
		WHERE id = $1`, itemID, winnerID, finalPrice)
	return err
}

func ExtendItemEndTime(ctx context.Context, pool *pgxpool.Pool, itemID string, newEndTime time.Time) error {
	_, err := pool.Exec(ctx, `UPDATE items SET end_time = $2 WHERE id = $1`, itemID, newEndTime)
	return err
}

// ListLiveItems returns the fields needed to (re)seed Redis state for every
// currently-live item. This covers not just items the ticker just activated
// but also ones that started out "live" already (e.g. seed data), which
// never pass through ActivateDueItems.
func ListLiveItems(ctx context.Context, pool *pgxpool.Pool) ([]models.Item, error) {
	rows, err := pool.Query(ctx, `SELECT id, starting_price, bid_increment, end_time FROM items WHERE status = 'live'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []models.Item{}
	for rows.Next() {
		var it models.Item
		if err := rows.Scan(&it.ID, &it.StartingPrice, &it.BidIncrement, &it.EndTime); err != nil {
			return nil, err
		}
		out = append(out, it)
	}
	return out, rows.Err()
}

// ---- audit log ----

// LogAudit writes an audit trail entry. userID may be empty for
// unauthenticated actions (e.g. a failed login attempt).
func LogAudit(ctx context.Context, pool *pgxpool.Pool, userID, action, entityType, entityID, details, ipAddress string) error {
	var uid *string
	if userID != "" {
		uid = &userID
	}
	_, err := pool.Exec(ctx,
		`INSERT INTO audit_log (user_id, action, entity_type, entity_id, details, ip_address)
		 VALUES ($1,$2,$3,$4,$5,$6)`,
		uid, action, entityType, entityID, details, ipAddress,
	)
	return err
}

// ---- bids ----

type BidInsert struct {
	RequestID string
	ItemID    string
	UserID    string
	Amount    float64
	Status    models.BidStatus
	Reason    string
	At        time.Time
	// AuditDetails is the audit_log entry's details for this decision
	// (action bid.accepted / bid.rejected follows from Status).
	AuditDetails string
}

// BatchInsertBids writes a batch of bids, each with its audit_log entry, in
// one round trip and one transaction. Idempotent per RequestID: a bid Kafka
// re-delivers after it was already written is skipped - its audit entry
// too, since that is only inserted alongside a newly inserted bids row - so
// retrying or replaying a batch never duplicates either.
//
// The audit entry used to be a separate fire-and-forget insert, which
// silently lost every decision made while Postgres was down (TC-11).
func BatchInsertBids(ctx context.Context, pool *pgxpool.Pool, bids []BidInsert) error {
	if len(bids) == 0 {
		return nil
	}
	batch := &pgx.Batch{}
	for _, b := range bids {
		var requestID *string
		if b.RequestID != "" { // messages produced before request_id existed
			requestID = &b.RequestID
		}
		action := "bid.accepted"
		if b.Status != models.BidAccepted {
			action = "bid.rejected"
		}
		batch.Queue(
			`WITH ins AS (
			   INSERT INTO bids (request_id, item_id, user_id, amount, status, reason, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
			   ON CONFLICT (request_id) DO NOTHING
			   RETURNING item_id, user_id, created_at)
			 INSERT INTO audit_log (user_id, action, entity_type, entity_id, details, created_at)
			 SELECT user_id, $8, 'item', item_id::text, $9, created_at FROM ins`,
			requestID, b.ItemID, b.UserID, b.Amount, b.Status, b.Reason, b.At, action, b.AuditDetails,
		)
	}
	br := pool.SendBatch(ctx, batch)
	defer br.Close()
	for range bids {
		if _, err := br.Exec(); err != nil {
			return err
		}
	}
	return nil
}

func ListBidsForItem(ctx context.Context, pool *pgxpool.Pool, itemID string) ([]models.Bid, error) {
	if !models.IsUUID(itemID) {
		return nil, ErrNotFound
	}
	rows, err := pool.Query(ctx, `
		SELECT b.id, b.item_id, b.user_id, u.display_name, b.amount, b.status, b.reason, b.created_at
		FROM bids b JOIN users u ON u.id = b.user_id
		WHERE b.item_id = $1
		ORDER BY b.created_at DESC`, itemID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []models.Bid{}
	for rows.Next() {
		var b models.Bid
		if err := rows.Scan(&b.ID, &b.ItemID, &b.UserID, &b.UserName, &b.Amount, &b.Status, &b.Reason, &b.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// LeadingBid is the highest accepted bid on an item. Used to rebuild or
// correct an item's Redis state from Postgres when Redis lost some or all of
// it, so the item resumes at its real price/leader instead of an older one.
type LeadingBid struct {
	BidderID, BidderName string
	Amount               float64
}

// LeadingBidsForLiveItems returns the leading accepted bid of every live item
// that has one, in a single query (bid-worker reads it every lifecycle tick to
// check Redis against Postgres).
func LeadingBidsForLiveItems(ctx context.Context, pool *pgxpool.Pool) (map[string]LeadingBid, error) {
	rows, err := pool.Query(ctx, `
		SELECT DISTINCT ON (b.item_id) b.item_id, b.user_id, u.display_name, b.amount
		FROM bids b
		JOIN items i ON i.id = b.item_id AND i.status = 'live'
		JOIN users u ON u.id = b.user_id
		WHERE b.status = 'accepted'
		ORDER BY b.item_id, b.amount DESC, b.created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]LeadingBid{}
	for rows.Next() {
		var id string
		var lb LeadingBid
		if err := rows.Scan(&id, &lb.BidderID, &lb.BidderName, &lb.Amount); err != nil {
			return nil, err
		}
		out[id] = lb
	}
	return out, rows.Err()
}

func ListBidsForUser(ctx context.Context, pool *pgxpool.Pool, userID string) ([]models.Bid, error) {
	rows, err := pool.Query(ctx, `
		SELECT b.id, b.item_id, i.title, b.user_id, b.amount, b.status, b.reason, b.created_at
		FROM bids b JOIN items i ON i.id = b.item_id
		WHERE b.user_id = $1
		ORDER BY b.created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []models.Bid{}
	for rows.Next() {
		var b models.Bid
		if err := rows.Scan(&b.ID, &b.ItemID, &b.ItemTitle, &b.UserID, &b.Amount, &b.Status, &b.Reason, &b.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}
