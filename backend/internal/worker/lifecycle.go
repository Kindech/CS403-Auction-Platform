package worker

import (
	"context"
	"log"
	"time"

	"auction/backend/internal/db"
	"auction/backend/internal/models"
	"auction/backend/internal/redisstate"
)

// runLifecycle activates items whose start_time has arrived and finalizes
// items whose (possibly anti-snipe-extended) end_time has passed. Running
// this from the same goroutine that adjudicates bids means an item can
// never be "finalized" out from under a bid that's concurrently updating
// its Redis state - there is no concurrency between the two to race.
func (w *Worker) runLifecycle(ctx context.Context) {
	activated, err := db.ActivateDueItems(ctx, w.pool)
	if err != nil {
		log.Printf("worker: activate due items: %v", err)
	}
	for _, it := range activated {
		exists, _ := redisstate.Exists(ctx, w.rdb, it.ID)
		if exists {
			continue
		}
		_ = redisstate.Init(ctx, w.rdb, models.AuctionState{
			ItemID:       it.ID,
			Price:        it.StartingPrice,
			MinIncrement: it.BidIncrement,
			EndTimeMs:    it.EndTime.UnixMilli(),
		})
		log.Printf("worker: activated item %s", it.ID)
	}

	liveItems, err := db.ListLiveItems(ctx, w.pool)
	if err != nil {
		log.Printf("worker: list live items: %v", err)
		return
	}
	nowMs := time.Now().UnixMilli()
	for _, it := range liveItems {
		state, ok, err := redisstate.Get(ctx, w.rdb, it.ID)
		if err != nil {
			continue
		}
		if !ok {
			// Live in Postgres but no Redis state yet (e.g. seed data
			// inserted directly as "live") - backfill it so bids work.
			state = models.AuctionState{
				ItemID:       it.ID,
				Price:        it.StartingPrice,
				MinIncrement: it.BidIncrement,
				EndTimeMs:    it.EndTime.UnixMilli(),
			}
			if err := redisstate.Init(ctx, w.rdb, state); err != nil {
				log.Printf("worker: backfill redis state for item %s: %v", it.ID, err)
				continue
			}
			log.Printf("worker: backfilled missing redis state for live item %s", it.ID)
		}
		if state.EndTimeMs > nowMs {
			continue
		}
		w.finalizeItem(ctx, it.ID, state)
	}
}

func (w *Worker) finalizeItem(ctx context.Context, itemID string, state models.AuctionState) {
	var winnerID *string
	var finalPrice *float64
	if state.BidderID != "" {
		id := state.BidderID
		price := state.Price
		winnerID, finalPrice = &id, &price
	}

	if err := db.FinalizeItem(ctx, w.pool, itemID, winnerID, finalPrice); err != nil {
		log.Printf("worker: finalize item %s: %v", itemID, err)
		return // retry on next tick rather than deleting redis state
	}

	ev := notifyEvent{Type: "auction_ended", ItemID: itemID, BidderName: state.BidderName}
	if finalPrice != nil {
		ev.FinalPrice = *finalPrice
		ev.WinnerName = state.BidderName
	}
	w.notifier.NotifyAll(ev)

	_ = redisstate.Delete(ctx, w.rdb, itemID)
	log.Printf("worker: finalized item %s (winner=%s price=%v)", itemID, state.BidderName, finalPrice)
}
