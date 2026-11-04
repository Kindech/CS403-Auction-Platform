// Package decision holds the pure bid-adjudication logic used by bid-worker.
// It has no I/O so it can be unit tested without Redis, Kafka, or Postgres.
package decision

import "auction/backend/internal/models"

type Outcome struct {
	Accepted     bool
	Reason       string // set when !Accepted
	NewState     models.AuctionState
	SoftExtended bool
}

// Decide adjudicates a single bid against the current auction state.
// now and bidTime are unix-millis. antiSnipeWindow/antiSnipeExt are in millis.
func Decide(state models.AuctionState, bidderID, bidderName string, amount float64, bidTimeMs int64, antiSnipeWindowMs, antiSnipeExtMs int64) Outcome {
	if bidTimeMs > state.EndTimeMs {
		return Outcome{Accepted: false, Reason: "auction_closed", NewState: state}
	}

	// In cents: as floats, 0.1 + 0.2 is more than 0.3 and a correct bid of
	// exactly 0.3 would be rejected as too low.
	minRequired := models.Cents(state.Price) + models.Cents(state.MinIncrement)
	if state.BidderID == "" {
		// no bids yet: the starting price itself is an acceptable opening bid
		minRequired = models.Cents(state.Price)
	}
	if models.Cents(amount) < minRequired {
		return Outcome{Accepted: false, Reason: "bid_too_low", NewState: state}
	}

	newState := state
	newState.Price = amount
	newState.BidderID = bidderID
	newState.BidderName = bidderName

	extended := false
	if state.EndTimeMs-bidTimeMs <= antiSnipeWindowMs {
		// max: a window longer than the extension must not shorten the auction
		newState.EndTimeMs = max(state.EndTimeMs, bidTimeMs+antiSnipeExtMs)
		extended = newState.EndTimeMs != state.EndTimeMs
	}

	return Outcome{Accepted: true, NewState: newState, SoftExtended: extended}
}
