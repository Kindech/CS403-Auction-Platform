package worker

import (
	"testing"
	"time"

	"auction/backend/internal/db"
	"auction/backend/internal/models"
)

func TestReconcileState(t *testing.T) {
	end := time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)
	item := models.Item{ID: "i1", EndTime: end}
	redis := models.AuctionState{ItemID: "i1", Price: 120, BidderID: "u1", BidderName: "A", MinIncrement: 10, EndTimeMs: end.UnixMilli()}

	t.Run("redis lost the last bid: restored from postgres", func(t *testing.T) {
		got, changed := reconcileState(redis, item, db.LeadingBid{BidderID: "u2", BidderName: "B", Amount: 130}, true)
		if !changed || got.Price != 130 || got.BidderID != "u2" || got.BidderName != "B" {
			t.Fatalf("got %+v changed=%v, want price 130 by u2", got, changed)
		}
		if got.MinIncrement != 10 || got.EndTimeMs != end.UnixMilli() {
			t.Fatalf("other fields changed: %+v", got)
		}
	})

	t.Run("redis ahead of postgres (rows still being batched): untouched", func(t *testing.T) {
		if got, changed := reconcileState(redis, item, db.LeadingBid{BidderID: "u3", Amount: 110}, true); changed || got != redis {
			t.Fatalf("got %+v changed=%v, want no change", got, changed)
		}
	})

	t.Run("same price: untouched", func(t *testing.T) {
		if _, changed := reconcileState(redis, item, db.LeadingBid{BidderID: "u1", Amount: 120.000001}, true); changed {
			t.Fatal("changed on an equal price")
		}
	})

	t.Run("no bids in postgres: untouched", func(t *testing.T) {
		if _, changed := reconcileState(redis, item, db.LeadingBid{}, false); changed {
			t.Fatal("changed with no bids")
		}
	})

	t.Run("redis lost an anti-snipe extension: end time restored", func(t *testing.T) {
		extended := item
		extended.EndTime = end.Add(time.Minute)
		got, changed := reconcileState(redis, extended, db.LeadingBid{}, false)
		if !changed || got.EndTimeMs != extended.EndTime.UnixMilli() {
			t.Fatalf("got end %d changed=%v, want %d", got.EndTimeMs, changed, extended.EndTime.UnixMilli())
		}
	})

	t.Run("end time is never moved earlier", func(t *testing.T) {
		later := redis
		later.EndTimeMs = end.Add(time.Minute).UnixMilli()
		if _, changed := reconcileState(later, item, db.LeadingBid{}, false); changed {
			t.Fatal("moved the end time back")
		}
	})
}
