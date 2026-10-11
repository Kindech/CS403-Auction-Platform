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

// RegisterFailedLogin atomically increments the account's failed-attempt
// counter and, once it reaches maxAttempts, locks the account for
// lockoutDuration and resets the counter for the next window. Returns
// whether this call was the one that triggered the lock.
func RegisterFailedLogin(ctx context.Context, pool *pgxpool.Pool, userID string, maxAttempts int, lockoutDuration time.Duration) (justLocked bool, err error) {
	err = pool.QueryRow(ctx, `
		WITH next AS (
			SELECT failed_login_attempts + 1 AS attempts FROM users WHERE id = $1
		)
		UPDATE users u
		SET failed_login_attempts = CASE WHEN next.attempts >= $2 THEN 0 ELSE next.attempts END,
		    locked_until = CASE WHEN next.attempts >= $2 THEN now() + make_interval(secs => $3) ELSE u.locked_until END
		FROM next
		WHERE u.id = $1
		RETURNING next.attempts >= $2`,
		userID, maxAttempts, lockoutDuration.Seconds(),
	).Scan(&justLocked)
	return justLocked, err
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
		`INSERT INTO items (seller_id, title, description, image_url, starting_price, bid_increment, start_time, end_time, status)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		 RETURNING id, created_at, status`,
		it.SellerID, it.Title, it.Description, it.ImageURL, it.StartingPrice, it.BidIncrement, it.StartTime, it.EndTime, status,
	).Scan(&it.ID, &it.CreatedAt, &it.Status)
	it.CurrentPrice = it.StartingPrice
	return it, err
}

const itemSelectCols = `
	i.id, i.seller_id, u.display_name, i.title, i.description, i.image_url,
	i.starting_price, i.bid_increment, i.start_time, i.end_time, i.status,
	i.winner_id, w.display_name, i.final_price, i.created_at`

func scanItem(row pgx.Row) (models.Item, error) {
	var it models.Item
	var winnerID, winnerName *string
	var finalPrice *float64
	err := row.Scan(
		&it.ID, &it.SellerID, &it.SellerName, &it.Title, &it.Description, &it.ImageURL,
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
}

// BatchInsertBids writes a batch of bid audit records in one round trip.
// Idempotent per RequestID: a bid Kafka re-delivers after it was already
// written is skipped, so retrying or replaying a batch never duplicates rows.
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
		batch.Queue(
			`INSERT INTO bids (request_id, item_id, user_id, amount, status, reason, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
			 ON CONFLICT (request_id) DO NOTHING`,
			requestID, b.ItemID, b.UserID, b.Amount, b.Status, b.Reason, b.At,
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

// GetLeadingBid returns the highest accepted bid recorded for an item, if
// any. Used to rebuild an item's Redis state from Postgres when Redis lost
// it, so the item resumes at its real price/leader instead of resetting to
// the starting price and finalizing as "no bids".
func GetLeadingBid(ctx context.Context, pool *pgxpool.Pool, itemID string) (bidderID, bidderName string, amount float64, ok bool, err error) {
	err = pool.QueryRow(ctx, `
		SELECT b.user_id, u.display_name, b.amount
		FROM bids b JOIN users u ON u.id = b.user_id
		WHERE b.item_id = $1 AND b.status = 'accepted'
		ORDER BY b.amount DESC, b.created_at ASC
		LIMIT 1`, itemID,
	).Scan(&bidderID, &bidderName, &amount)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", 0, false, nil
	}
	return bidderID, bidderName, amount, err == nil, err
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
