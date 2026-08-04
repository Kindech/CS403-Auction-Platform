package decision

import (
	"testing"

	"auction/backend/internal/models"
)

func baseState() models.AuctionState {
	return models.AuctionState{
		ItemID:       "item-1",
		Price:        100,
		BidderID:     "u1",
		BidderName:   "Alice",
		EndTimeMs:    1_000_000,
		MinIncrement: 10,
	}
}

func TestDecide_AcceptsHigherBid(t *testing.T) {
	s := baseState()
	out := Decide(s, "u2", "Bob", 110, 500_000, 60_000, 60_000)
	if !out.Accepted {
		t.Fatalf("expected accept, got reject: %s", out.Reason)
	}
	if out.NewState.Price != 110 || out.NewState.BidderID != "u2" {
		t.Fatalf("unexpected new state: %+v", out.NewState)
	}
	if out.SoftExtended {
		t.Fatalf("should not extend, far from end")
	}
}

func TestDecide_RejectsTooLow(t *testing.T) {
	s := baseState()
	out := Decide(s, "u2", "Bob", 105, 500_000, 60_000, 60_000) // needs >= 110
	if out.Accepted {
		t.Fatalf("expected reject, got accept")
	}
	if out.Reason != "bid_too_low" {
		t.Fatalf("expected bid_too_low, got %s", out.Reason)
	}
	// state must be unchanged on reject
	if out.NewState.Price != s.Price || out.NewState.BidderID != s.BidderID {
		t.Fatalf("state must not change on reject")
	}
}

func TestDecide_RejectsEqualBid(t *testing.T) {
	s := baseState()
	out := Decide(s, "u2", "Bob", 100, 500_000, 60_000, 60_000)
	if out.Accepted {
		t.Fatalf("equal bid without meeting increment must be rejected")
	}
}

func TestDecide_RejectsAfterClose(t *testing.T) {
	s := baseState()
	out := Decide(s, "u2", "Bob", 200, 1_000_001, 60_000, 60_000)
	if out.Accepted {
		t.Fatalf("bid after end_time must be rejected")
	}
	if out.Reason != "auction_closed" {
		t.Fatalf("expected auction_closed, got %s", out.Reason)
	}
}

func TestDecide_AcceptsExactlyAtCloseBoundary(t *testing.T) {
	s := baseState()
	out := Decide(s, "u2", "Bob", 200, 1_000_000, 60_000, 60_000)
	if !out.Accepted {
		t.Fatalf("bid exactly at end_time boundary should still be accepted")
	}
}

func TestDecide_TwoIdenticalBidsOnlyOneCanWin(t *testing.T) {
	// Simulates TC-02 "The Duel": two identical amounts arriving in strict
	// sequence (as guaranteed by Kafka ordering) - the first must win,
	// the second (now stale relative to the just-updated state) must lose.
	s := baseState()
	first := Decide(s, "u2", "Bob", 150, 500_000, 60_000, 60_000)
	if !first.Accepted {
		t.Fatalf("first identical bid should be accepted")
	}
	second := Decide(first.NewState, "u3", "Carol", 150, 500_001, 60_000, 60_000)
	if second.Accepted {
		t.Fatalf("second identical bid against the already-updated state must be rejected")
	}
}

func TestDecide_SoftCloseExtendsWithinAntiSnipeWindow(t *testing.T) {
	s := baseState()
	// bid arrives with only 10s left, anti-snipe window is 60s -> must extend
	bidTime := s.EndTimeMs - 10_000
	out := Decide(s, "u2", "Bob", 150, bidTime, 60_000, 60_000)
	if !out.Accepted {
		t.Fatalf("expected accept")
	}
	if !out.SoftExtended {
		t.Fatalf("expected soft-close extension within anti-snipe window")
	}
	wantEnd := bidTime + 60_000
	if out.NewState.EndTimeMs != wantEnd {
		t.Fatalf("expected new end_time %d, got %d", wantEnd, out.NewState.EndTimeMs)
	}
}

func TestDecide_NoExtensionOutsideAntiSnipeWindow(t *testing.T) {
	s := baseState()
	bidTime := s.EndTimeMs - 120_000 // 2 minutes left, window is 60s
	out := Decide(s, "u2", "Bob", 150, bidTime, 60_000, 60_000)
	if !out.Accepted {
		t.Fatalf("expected accept")
	}
	if out.SoftExtended {
		t.Fatalf("should not extend outside anti-snipe window")
	}
	if out.NewState.EndTimeMs != s.EndTimeMs {
		t.Fatalf("end_time must be unchanged outside anti-snipe window")
	}
}

func TestDecide_OpeningBidAtStartingPriceAccepted(t *testing.T) {
	s := models.AuctionState{
		ItemID:       "item-2",
		Price:        50,
		BidderID:     "",
		BidderName:   "",
		EndTimeMs:    1_000_000,
		MinIncrement: 5,
	}
	// No bidder yet: the starting price itself should be biddable.
	out := Decide(s, "u1", "Alice", 50, 100, 60_000, 60_000)
	if !out.Accepted {
		t.Fatalf("opening bid at starting price should be accepted, reason=%s", out.Reason)
	}
}
