package ws

// Event is the single wire-format used both for bid-worker -> api-server
// "/internal/events" notifications and for api-server -> browser WS pushes.
// One shape for both keeps the fan-out path trivial: a server that receives
// an Event from the worker forwards it (almost) verbatim to the room.
type Event struct {
	Type string `json:"type"` // sync | price_update | bid_rejected | auction_ended

	ItemID string `json:"item_id"`

	// price_update / sync
	Price        float64 `json:"price,omitempty"`
	BidderName   string  `json:"bidder_name,omitempty"`
	EndTimeMs    int64   `json:"end_time_ms,omitempty"`
	MinIncrement float64 `json:"min_increment,omitempty"`
	SoftExtended bool    `json:"soft_extended,omitempty"`

	// bid_rejected - routed to exactly one connection
	TargetUserID string `json:"-"` // never serialized to the browser
	Reason       string `json:"reason,omitempty"`

	// auction_ended
	WinnerName string  `json:"winner_name,omitempty"`
	FinalPrice float64 `json:"final_price,omitempty"`
}

const (
	EventSync            = "sync"
	EventPriceUpdate     = "price_update"
	EventBidRejected     = "bid_rejected"
	EventAuctionEnded    = "auction_ended"
)
