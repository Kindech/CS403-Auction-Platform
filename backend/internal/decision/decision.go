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

	minRequired := state.Price + state.MinIncrement
	if state.BidderID == "" {
		// no bids yet: the starting price itself is an acceptable opening bid
		minRequired = state.Price
	}
	if amount < minRequired {
		return Outcome{Accepted: false, Reason: "bid_too_low", NewState: state}
	}

	newState := state
	newState.Price = amount
	newState.BidderID = bidderID
	newState.BidderName = bidderName

	extended := false
	if state.EndTimeMs-bidTimeMs <= antiSnipeWindowMs {
		newState.EndTimeMs = bidTimeMs + antiSnipeExtMs
		extended = true
	}

	return Outcome{Accepted: true, NewState: newState, SoftExtended: extended}
}
