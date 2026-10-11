package models

import "time"

type User struct {
	ID                  string     `json:"id"`
	Email               string     `json:"email"`
	PasswordHash        string     `json:"-"`
	DisplayName         string     `json:"display_name"`
	CreatedAt           time.Time  `json:"created_at"`
	FailedLoginAttempts int        `json:"-"`
	LockedUntil         *time.Time `json:"-"`
}

type ItemStatus string

const (
	ItemUpcoming ItemStatus = "upcoming"
	ItemLive     ItemStatus = "live"
	ItemEnded    ItemStatus = "ended"
)

type Item struct {
	ID             string     `json:"id"`
	SellerID       string     `json:"seller_id"`
	SellerName     string     `json:"seller_name,omitempty"`
	Title          string     `json:"title"`
	Description    string     `json:"description"`
	ImageURL       string     `json:"image_url"`
	StartingPrice  float64    `json:"starting_price"`
	BidIncrement   float64    `json:"bid_increment"`
	CurrentPrice   float64    `json:"current_price"`
	CurrentBidder  string     `json:"current_bidder,omitempty"`
	StartTime      time.Time  `json:"start_time"`
	EndTime        time.Time  `json:"end_time"`
	Status         ItemStatus `json:"status"`
	WinnerID       *string    `json:"winner_id,omitempty"`
	WinnerName     *string    `json:"winner_name,omitempty"`
	FinalPrice     *float64   `json:"final_price,omitempty"`
	CreatedAt      time.Time  `json:"created_at"`
}

type BidStatus string

const (
	BidAccepted BidStatus = "accepted"
	BidRejected BidStatus = "rejected"
)

type Bid struct {
	ID         string    `json:"id"`
	ItemID     string    `json:"item_id"`
	UserID     string    `json:"user_id"`
	UserName   string    `json:"user_name,omitempty"`
	ItemTitle  string    `json:"item_title,omitempty"`
	Amount     float64   `json:"amount"`
	Status     BidStatus `json:"status"`
	Reason     string    `json:"reason,omitempty"`
	CreatedAt  time.Time `json:"created_at"`
}

// BidRequest is the raw message an api-server produces onto Kafka.
type BidRequest struct {
	// RequestID uniquely identifies this bid across Kafka re-deliveries, so
	// replaying it can never write a second bids row.
	RequestID string    `json:"request_id"`
	ItemID    string    `json:"item_id"`
	UserID    string    `json:"user_id"`
	UserName  string    `json:"user_name"`
	Amount    float64   `json:"amount"`
	Timestamp time.Time `json:"timestamp"`
}

// AuctionState mirrors the Redis hash for one item.
type AuctionState struct {
	ItemID       string  `json:"item_id"`
	Price        float64 `json:"price"`
	BidderID     string  `json:"bidder_id"`
	BidderName   string  `json:"bidder_name"`
	EndTimeMs    int64   `json:"end_time_ms"`
	MinIncrement float64 `json:"min_increment"`
}
