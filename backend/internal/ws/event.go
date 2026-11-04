package ws

// Event is the api-server -> browser WS wire format. It mirrors
// eventbus.Message (bid-worker -> api-server) field for field, which keeps
// the fan-out path trivial: a server that receives a message from the worker
// forwards it (almost) verbatim to the room.
type Event struct {
	Type string `json:"type"` // sync | price_update | bid_rejected | outbid | auction_ended

	ItemID string `json:"item_id"`

	// price_update / sync
	Price        float64 `json:"price,omitempty"`
	BidderName   string  `json:"bidder_name,omitempty"`
	EndTimeMs    int64   `json:"end_time_ms,omitempty"`
	MinIncrement float64 `json:"min_increment,omitempty"`
	SoftExtended bool    `json:"soft_extended,omitempty"`

	// bid_rejected - routed to exactly one connection
	TargetUserID string  `json:"-"` // never serialized to the browser
	Reason       string  `json:"reason,omitempty"`
	Amount       float64 `json:"amount,omitempty"` // the rejected bid, so a late rejection can't be mistaken for a newer bid's

	// auction_ended
	WinnerName string  `json:"winner_name,omitempty"`
	FinalPrice float64 `json:"final_price,omitempty"`

	// NameOwnerID identifies whose name BidderName/WinnerName belongs to.
	// BroadcastToRoom masks that name (see models.MaskDisplayName) for every
	// recipient except the connection whose UserID matches - never
	// serialized, it only steers server-side masking before marshal.
	NameOwnerID string `json:"-"`
}

const (
	EventSync            = "sync"
	EventPriceUpdate     = "price_update"
	EventBidRejected     = "bid_rejected"
	EventAuctionEnded    = "auction_ended"
)
