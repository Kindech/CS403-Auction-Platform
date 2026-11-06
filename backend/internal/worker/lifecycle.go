package worker

import (
	"context"
	"fmt"
	"log"
	"time"

	"auction/backend/internal/db"
	"auction/backend/internal/metrics"
	"auction/backend/internal/models"
	"auction/backend/internal/redisstate"
)

// The auction lifecycle - activating items whose start_time has arrived and
// finalizing items whose (possibly anti-snipe-extended) end_time has passed -
// is split in two:
//
//   - lifecycleLoop, its own goroutine, does the Postgres reads each tick and
//     hands Run a lifecycleSnapshot. It used to run on the adjudication
//     goroutine, where every tick's query stalled bidding for up to its
//     timeout while Postgres was down (TC-11).
//   - applyLifecycle runs on the adjudication goroutine and does everything
//     that touches an item's Redis state. An item can therefore never be
//     finalized out from under a bid that's concurrently updating its state -
//     there is no concurrency between the two to race.
//   - Finalizing happens when the item's close marker comes back through
//     Kafka (requestClose/handleClose), after every bid queued ahead of it.

const lifecycleDBTimeout = 2 * time.Second

// lifecycleSnapshot is one tick's view of Postgres.
type lifecycleSnapshot struct {
	activated []models.Item
	live      []models.Item
	// leading holds the leading accepted bid of every live item that has one,
	// for applyLifecycle to rebuild missing Redis state or correct stale state.
	leading map[string]db.LeadingBid
}

// lifecycleLoop reads a snapshot every TickInterval and sends it to Run.
// After a failure it backs off exponentially so a down database isn't
// hammered (or the log flooded) once a second.
func (w *Worker) lifecycleLoop(ctx context.Context, out chan<- lifecycleSnapshot) {
	ticker := time.NewTicker(w.cfg.TickInterval)
	defer ticker.Stop()
	var backoff time.Duration
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		snap, err := w.readLifecycle(ctx)
		if err != nil {
			backoff = min(max(backoff*2, time.Second), 30*time.Second)
			log.Printf("worker: lifecycle read failed, next attempt in %s: %v", backoff, err)
			select {
			case <-time.After(backoff):
			case <-ctx.Done():
				return
			}
			continue
		}
		backoff = 0
		select {
		case out <- snap:
		case <-ctx.Done():
			return
		}
	}
}

func (w *Worker) readLifecycle(ctx context.Context) (lifecycleSnapshot, error) {
	ctx, cancel := context.WithTimeout(ctx, lifecycleDBTimeout)
	defer cancel()
	var s lifecycleSnapshot
	var err error
	if s.activated, err = db.ActivateDueItems(ctx, w.pool); err != nil {
		return s, fmt.Errorf("activate due items: %w", err)
	}
	if s.live, err = db.ListLiveItems(ctx, w.pool); err != nil {
		return s, fmt.Errorf("list live items: %w", err)
	}
	if s.leading, err = db.LeadingBidsForLiveItems(ctx, w.pool); err != nil {
		return s, fmt.Errorf("look up leading bids: %w", err)
	}
	return s, nil
}

// applyLifecycle acts on a snapshot. Only finalizing writes to Postgres from
// here, and only right after a snapshot proved Postgres reachable.
func (w *Worker) applyLifecycle(ctx context.Context, s lifecycleSnapshot) {
	for id, at := range w.finalized {
		if time.Since(at) > time.Minute {
			delete(w.finalized, id)
		}
	}
	for id, at := range w.closeRequested {
		if time.Since(at) > time.Minute { // an item deleted by hand never closes
			delete(w.closeRequested, id)
		}
	}

	for _, it := range s.activated {
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

	nowMs := time.Now().UnixMilli()
	for _, it := range s.live {
		if _, done := w.finalized[it.ID]; done {
			continue // the snapshot was read before we finalized it
		}
		state, ok, err := redisstate.Get(ctx, w.rdb, it.ID)
		if err != nil {
			continue
		}
		lb, hasBid := s.leading[it.ID]
		if !ok {
			// Live in Postgres but no Redis state - either it never had any
			// (seed data inserted directly as "live") or Redis lost it (e.g.
			// restarted without persistence). Rebuild from the bids audit
			// trail, not just the starting price: otherwise the item resets
			// to its opening price and finalizes as "no bids" even though
			// people bid on it.
			state = models.AuctionState{
				ItemID:       it.ID,
				Price:        it.StartingPrice,
				MinIncrement: it.BidIncrement,
				EndTimeMs:    it.EndTime.UnixMilli(),
			}
			if hasBid {
				state.Price, state.BidderID, state.BidderName = lb.Amount, lb.BidderID, lb.BidderName
			}
			if err := redisstate.Init(ctx, w.rdb, state); err != nil {
				log.Printf("worker: backfill redis state for item %s: %v", it.ID, err)
				continue
			}
			metrics.RedisStateRepairsTotal.WithLabelValues("rebuilt").Inc()
			log.Printf("worker: backfilled missing redis state for live item %s", it.ID)
		} else if fixed, changed := reconcileState(state, it, lb, hasBid); changed {
			// Redis has the item but is behind Postgres: it lost writes it had
			// already acknowledged (an OS or power crash takes up to the last
			// second of the AOF with it). Every row in Postgres was accepted
			// into Redis first, so Postgres can only be behind Redis, never
			// ahead - unless Redis lost data. Put the missing bid back so the
			// next bid is judged against the real price.
			if err := redisstate.Init(ctx, w.rdb, fixed); err != nil {
				log.Printf("worker: reconcile redis state for item %s: %v", it.ID, err)
				continue
			}
			metrics.RedisStateRepairsTotal.WithLabelValues("reconciled").Inc()
			log.Printf("worker: redis state of item %s was behind postgres (price %.2f -> %.2f, end %d -> %d) - restored",
				it.ID, state.Price, fixed.Price, state.EndTimeMs, fixed.EndTimeMs)
			state = fixed
		}
		if !closeDue(state, nowMs) {
			continue
		}
		w.requestClose(it.ID)
	}
}

// reconcileState brings an item's Redis state up to what Postgres proves it
// had: the leading accepted bid and the (anti-snipe extended) end time. It only
// ever moves state forward, so a snapshot that is a moment older than Redis
// (bids accepted since, rows still being batched) changes nothing.
func reconcileState(state models.AuctionState, it models.Item, lb db.LeadingBid, hasBid bool) (models.AuctionState, bool) {
	changed := false
	if hasBid && models.Cents(lb.Amount) > models.Cents(state.Price) {
		state.Price, state.BidderID, state.BidderName = lb.Amount, lb.BidderID, lb.BidderName
		changed = true
	}
	if end := it.EndTime.UnixMilli(); end > state.EndTimeMs {
		state.EndTimeMs = end
		changed = true
	}
	return state, changed
}

// closeDue reports whether an item can be finalized once every bid already in
// Kafka has been decided. It waits BidExpiry past the end time because a bid
// stamped just before the end can still be on its way to the broker for that
// long; after that the broker refuses it, so nothing in time can land after
// the close marker.
func closeDue(state models.AuctionState, nowMs int64) bool {
	return nowMs >= state.EndTimeMs+models.BidExpiry.Milliseconds()
}

// closeRetryInterval is how long to wait for a close marker to come back
// through Kafka before publishing another.
const closeRetryInterval = 5 * time.Second

// requestClose publishes an item's close marker instead of finalizing it here.
// The marker lands on the same partition as the item's bids, so it comes back
// only after every earlier bid has been decided. Finalizing straight from the
// lifecycle tick used to overtake any backlog (a worker restart, a rebalance, a
// sniping burst): bids placed in time were then rejected as auction_not_live
// and the item could end with no winner (TC-13).
func (w *Worker) requestClose(itemID string) {
	if at, ok := w.closeRequested[itemID]; ok && time.Since(at) < closeRetryInterval {
		return
	}
	w.closeRequested[itemID] = time.Now()
	go func() { // never hold up adjudication on Kafka
		ctx, cancel := context.WithTimeout(context.Background(), closeRetryInterval)
		defer cancel()
		if err := w.producer.PublishItemClose(ctx, itemID); err != nil {
			log.Printf("worker: publish close marker for item %s (will retry): %v", itemID, err)
		}
	}()
}

// handleClose runs when an item's close marker comes back through Kafka: every
// bid before it has been decided, so the state is final unless one of those
// bids extended the auction - then a later tick sends a new marker.
func (w *Worker) handleClose(ctx context.Context, itemID string) {
	delete(w.closeRequested, itemID)
	state, ok, err := redisstate.Get(ctx, w.rdb, itemID)
	if err != nil {
		log.Printf("worker: read state to close item %s: %v", itemID, err)
		return // the next tick publishes another marker
	}
	if !ok || !closeDue(state, time.Now().UnixMilli()) {
		return // already finalized (a replayed marker), or extended
	}
	fctx, cancel := context.WithTimeout(ctx, lifecycleDBTimeout)
	defer cancel()
	w.finalizeItem(fctx, itemID, state)
}

func (w *Worker) finalizeItem(ctx context.Context, itemID string, state models.AuctionState) {
	var winnerID *string
	var finalPrice *float64
	if state.BidderID != "" {
		id := state.BidderID
		price := state.Price
		winnerID, finalPrice = &id, &price
	}

	err := db.FinalizeItem(ctx, w.pool, itemID, winnerID, finalPrice)
	if db.IsPermanent(err) && winnerID != nil {
		// The winner's account was deleted by hand: retrying would leave the
		// item live forever, so it closes unsold instead.
		log.Printf("worker: item %s can't record its winner %s, closing it unsold: %v", itemID, *winnerID, err)
		winnerID, finalPrice = nil, nil
		state.BidderName = ""
		err = db.FinalizeItem(ctx, w.pool, itemID, nil, nil)
	}
	if err != nil {
		log.Printf("worker: finalize item %s: %v", itemID, err)
		return // retry on next tick rather than deleting redis state
	}

	ev := notifyEvent{Type: "auction_ended", ItemID: itemID, BidderName: state.BidderName}
	outcome := "unsold"
	if finalPrice != nil {
		ev.FinalPrice = *finalPrice
		ev.WinnerName = state.BidderName
		ev.NameOwnerID = *winnerID
		outcome = "sold"
	}
	metrics.ItemsFinalizedTotal.WithLabelValues(outcome).Inc()
	w.notifier.NotifyAll(ev)

	w.logItemEnded(itemID, winnerID, state.BidderName, finalPrice)

	_ = redisstate.Delete(ctx, w.rdb, itemID)
	w.finalized[itemID] = time.Now()
	log.Printf("worker: finalized item %s (winner=%s price=%v)", itemID, state.BidderName, finalPrice)
}

// logItemEnded records the auction's outcome in audit_log - who won (if
// anyone) and the final price - completing the timeline alongside
// bid.accepted/bid.rejected and the account-activity events.
func (w *Worker) logItemEnded(itemID string, winnerID *string, winnerName string, finalPrice *float64) {
	details := "no bids"
	userID := ""
	if winnerID != nil {
		details = fmt.Sprintf("winner=%s price=%.2f", winnerName, *finalPrice)
		userID = *winnerID
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := db.LogAudit(ctx, w.pool, userID, "item.ended", "item", itemID, details, ""); err != nil {
			log.Printf("worker: log audit for item %s: %v", itemID, err)
		}
	}()
}
