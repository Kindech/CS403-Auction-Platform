package worker

import (
	"context"
	"fmt"
	"log"
	"time"

	kafka "github.com/segmentio/kafka-go"
	"github.com/redis/go-redis/v9"
	"github.com/jackc/pgx/v5/pgxpool"

	"auction/backend/internal/config"
	"auction/backend/internal/db"
	"auction/backend/internal/decision"
	"auction/backend/internal/kafkabus"
	"auction/backend/internal/metrics"
	"auction/backend/internal/models"
	"auction/backend/internal/redisstate"
)

type Worker struct {
	cfg      config.Config
	pool     *pgxpool.Pool
	rdb      *redis.Client
	consumer *kafkabus.Consumer
	producer *kafkabus.Producer // publishes item-close markers; see requestClose
	notifier *Notifier

	// finalized remembers items this worker just finalized, so a lifecycle
	// snapshot read before that can't bring one back. Only touched by Run's
	// goroutine.
	finalized map[string]time.Time
	// closeRequested is when each item's close marker was last published.
	// Only touched by Run's goroutine.
	closeRequested map[string]time.Time
}

func New(cfg config.Config, pool *pgxpool.Pool, rdb *redis.Client, consumer *kafkabus.Consumer, producer *kafkabus.Producer, notifier *Notifier) *Worker {
	return &Worker{cfg: cfg, pool: pool, rdb: rdb, consumer: consumer, producer: producer, notifier: notifier,
		finalized: map[string]time.Time{}, closeRequested: map[string]time.Time{}}
}

type fetchResult struct {
	req models.BidRequest
	msg kafka.Message
	err error
}

type pendingInsert struct {
	insert db.BidInsert
	msg    kafka.Message
	skip   bool // undecodable message: nothing to insert, but its offset still gets committed
}

// writeQueueBatches bounds how many batches can wait on Postgres (~50 bids
// each) before adjudication applies backpressure.
const writeQueueBatches = 1024

// Run is the single sequential adjudication loop. Deliberately
// single-goroutine: it is what makes read-decide-write on an item's Redis
// state race-free without any locking, and it's what makes the lifecycle
// ticker (activate/finalize items) safe to interleave with bid processing
// for the same item.
//
// Postgres is kept off this loop: batches go to writeLoop and lifecycle
// reads to lifecycleLoop, so a slow or down database delays the audit
// trail, never bid adjudication.
func (w *Worker) Run(ctx context.Context) {
	msgCh := make(chan fetchResult, 64)
	go w.fetchLoop(ctx, msgCh)

	lifecycleCh := make(chan lifecycleSnapshot)
	go w.lifecycleLoop(ctx, lifecycleCh)

	writeCh := make(chan []pendingInsert, writeQueueBatches)
	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		w.writeLoop(ctx, writeCh)
	}()

	flushTicker := time.NewTicker(w.cfg.BatchInterval)
	defer flushTicker.Stop()

	var buffer []pendingInsert
	enqueue := func() {
		if len(buffer) == 0 {
			return
		}
		select {
		case writeCh <- buffer:
		default:
			log.Printf("worker: write queue full (%d batches waiting on Postgres) - pausing adjudication until it drains", writeQueueBatches)
			writeCh <- buffer
		}
		buffer = nil
	}

	for {
		select {
		case <-ctx.Done():
			enqueue()
			close(writeCh)
			<-writerDone
			return

		case res := <-msgCh:
			if res.err != nil {
				log.Printf("worker: skipping undecodable message at %s/%d@%d: %v", res.msg.Topic, res.msg.Partition, res.msg.Offset, res.err)
				buffer = append(buffer, pendingInsert{msg: res.msg, skip: true})
			} else if res.req.Kind == models.KindItemClose {
				w.handleClose(ctx, res.req.ItemID)
				buffer = append(buffer, pendingInsert{msg: res.msg, skip: true})
			} else {
				ins := w.handleBid(ctx, res.req)
				buffer = append(buffer, pendingInsert{insert: ins, msg: res.msg})
			}
			if len(buffer) >= w.cfg.BatchSize {
				enqueue()
			}

		case <-flushTicker.C:
			enqueue()

		case snap := <-lifecycleCh:
			w.applyLifecycle(ctx, snap)
		}
	}
}

// fetchLoop feeds msgCh until ctx is cancelled. A broker error (Kafka
// restarting, network blip) is retried with backoff - it used to end this
// goroutine, after which the worker looked healthy but never processed
// another bid. Decode errors are passed on so the bad message gets skipped.
func (w *Worker) fetchLoop(ctx context.Context, msgCh chan<- fetchResult) {
	backoff := 500 * time.Millisecond
	for {
		req, msg, err := w.consumer.ReadBid(ctx)
		if ctx.Err() != nil {
			return
		}
		if err != nil && msg.Topic == "" { // nothing fetched: broker-side error
			log.Printf("worker: kafka fetch error (retrying in %s): %v", backoff, err)
			select {
			case <-time.After(backoff):
			case <-ctx.Done():
				return
			}
			backoff = min(backoff*2, 10*time.Second)
			continue
		}
		backoff = 500 * time.Millisecond
		select {
		case msgCh <- fetchResult{req, msg, err}:
		case <-ctx.Done():
			return
		}
	}
}

// writeLoop durably writes batches in arrival order, retrying each until it
// succeeds, then commits its offsets. Order matters: a Kafka commit covers
// everything before it in the partition, so batch N+1 must never be
// committed while batch N is unwritten. On shutdown, queued batches are
// still written while Postgres is reachable; after the first failure the
// rest are left uncommitted and replayed by the next worker (inserts are
// idempotent per request_id).
func (w *Worker) writeLoop(ctx context.Context, writeCh <-chan []pendingInsert) {
	for batch := range writeCh {
		backoff := 500 * time.Millisecond
		for !w.flush(batch) {
			select {
			case <-time.After(backoff):
				backoff = min(backoff*2, 10*time.Second)
			case <-ctx.Done():
				log.Printf("worker: shutting down with unwritten bids - leaving their offsets uncommitted for replay")
				for range writeCh { // drain so Run's close/wait can finish
				}
				return
			}
		}
	}
}

// handleBid adjudicates one bid: read state, decide, write state, notify.
// It never blocks on Postgres itself - the returned bids row (and its
// audit_log entry) is written by writeLoop, so a slow or down database can
// never add latency to the real-time broadcast path.
func (w *Worker) handleBid(ctx context.Context, req models.BidRequest) db.BidInsert {
	start := time.Now()
	defer func() { metrics.BidProcessingDuration.Observe(time.Since(start).Seconds()) }()

	reject := func(reason string) db.BidInsert {
		w.notifier.NotifyAll(notifyEvent{Type: "bid_rejected", ItemID: req.ItemID, TargetUserID: req.UserID, Reason: reason, Amount: req.Amount})
		metrics.BidsTotal.WithLabelValues("rejected", reason).Inc()
		return bidRecord(req, false, reason)
	}

	// The api-server already filters these out; re-checked here because an
	// out-of-range amount would otherwise be accepted into Redis and then
	// fail the whole Postgres batch with a numeric overflow.
	if !models.ValidBidAmount(req.Amount) {
		ins := reject("invalid_amount")
		ins.Amount = 0 // the raw value can't be stored; audit_log details keeps it
		return ins
	}

	// A replay (worker crashed after applying this bid but before its batch
	// reached Postgres) must be recorded as the acceptance it was. Running it
	// through Decide again would compare it against a price that already
	// includes it and log it as "bid_too_low". State and broadcast happened
	// the first time; the bids row and its audit_log entry are written now
	// unless the first attempt's batch already was (then this is a no-op).
	if applied, err := redisstate.WasApplied(ctx, w.rdb, req.ItemID, req.RequestID); err != nil {
		log.Printf("worker: redis applied-check failed for item %s: %v", req.ItemID, err)
	} else if applied {
		log.Printf("worker: replayed bid %s already applied to item %s - recording as accepted", req.RequestID, req.ItemID)
		return bidRecord(req, true, "")
	}

	state, ok, err := redisstate.Get(ctx, w.rdb, req.ItemID)
	if err != nil {
		log.Printf("worker: redis get failed for item %s: %v", req.ItemID, err)
		return w.rejectUnavailable(req)
	}
	if !ok {
		return reject("auction_not_live")
	}

	out := decision.Decide(state, req.UserID, req.UserName, req.Amount, req.Timestamp.UnixMilli(),
		w.cfg.AntiSnipeWindow.Milliseconds(), w.cfg.AntiSnipeExtension.Milliseconds())

	if !out.Accepted {
		return reject(out.Reason)
	}

	if err := redisstate.SetAccepted(ctx, w.rdb, out.NewState, req.RequestID); err != nil {
		// Not stored means not accepted: announcing it would show a price the
		// auction doesn't actually have.
		log.Printf("worker: redis set failed for item %s: %v", req.ItemID, err)
		return w.rejectUnavailable(req)
	}

	w.notifier.NotifyAll(notifyEvent{
		Type: "price_update", ItemID: req.ItemID,
		Price: out.NewState.Price, BidderName: out.NewState.BidderName,
		EndTimeMs: out.NewState.EndTimeMs, MinIncrement: out.NewState.MinIncrement,
		SoftExtended: out.SoftExtended, NameOwnerID: out.NewState.BidderID,
	})
	metrics.BidsTotal.WithLabelValues("accepted", "").Inc()

	// The person who was leading before this bid just got overtaken - tell
	// them directly (not the whole room) so they don't have to notice it
	// themselves from the price alone. New leader's name goes out masked:
	// the recipient here is never that person by definition.
	if state.BidderID != "" && state.BidderID != req.UserID {
		w.notifier.NotifyAll(notifyEvent{
			Type: "outbid", ItemID: req.ItemID, TargetUserID: state.BidderID,
			Price: out.NewState.Price, BidderName: models.MaskDisplayName(out.NewState.BidderName),
		})
	}

	if out.SoftExtended {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if err := db.ExtendItemEndTime(ctx, w.pool, req.ItemID, time.UnixMilli(out.NewState.EndTimeMs)); err != nil {
				log.Printf("worker: persist anti-snipe extension for item %s: %v", req.ItemID, err)
			}
		}()
	}

	return bidRecord(req, true, "")
}

// rejectUnavailable records a bid that couldn't be decided because Redis
// failed, and tells the bidder it wasn't recorded (best effort: the same outage
// can stop this notification, which is why api-server also checks Redis before
// accepting a bid).
func (w *Worker) rejectUnavailable(req models.BidRequest) db.BidInsert {
	w.notifier.NotifyAll(notifyEvent{Type: "bid_rejected", ItemID: req.ItemID, TargetUserID: req.UserID, Reason: "service_unavailable", Amount: req.Amount})
	metrics.BidsTotal.WithLabelValues("rejected", "internal_error").Inc()
	return bidRecord(req, false, "internal_error")
}

// bidRecord is the bids row for one decision, with its audit_log entry
// (action bid.accepted / bid.rejected) - a chronological view of every
// decision the worker makes, complementing the per-item bids table. Both
// are written together by writeLoop, so the audit trail survives a Postgres
// outage exactly like the bids do.
func bidRecord(req models.BidRequest, accepted bool, reason string) db.BidInsert {
	ins := db.BidInsert{RequestID: req.RequestID, ItemID: req.ItemID, UserID: req.UserID, Amount: req.Amount, At: req.Timestamp,
		Status: models.BidAccepted, AuditDetails: fmt.Sprintf("amount=%.2f", req.Amount)}
	if !accepted {
		ins.Status, ins.Reason = models.BidRejected, reason
		ins.AuditDetails = fmt.Sprintf("amount=%.2f reason=%s", req.Amount, reason)
	}
	return ins
}

// flush durably writes the audit batch to Postgres and only then commits
// Kafka offsets - the invariant that makes worker crashes lossless (report
// section 2.6.4: "at-least-once processing via offset commit"). Returns
// whether the batch was written; on false the caller retries it.
func (w *Worker) flush(buffer []pendingInsert) bool {
	if len(buffer) == 0 {
		return true
	}
	inserts := make([]db.BidInsert, 0, len(buffer))
	msgs := make([]kafka.Message, len(buffer))
	for i, p := range buffer {
		if !p.skip {
			inserts = append(inserts, p.insert)
		}
		msgs[i] = p.msg
	}

	writeCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := db.BatchInsertBids(writeCtx, w.pool, inserts); err != nil {
		if !db.IsPermanent(err) {
			log.Printf("worker: batch insert of %d bids failed, offsets NOT committed (will retry): %v", len(inserts), err)
			return false
		}
		log.Printf("worker: batch of %d bids has a row Postgres will never accept, writing them one by one: %v", len(inserts), err)
		if !w.insertIndividually(writeCtx, inserts) {
			return false
		}
	}
	if err := w.consumer.CommitOffset(writeCtx, msgs...); err != nil {
		// Rows are durable; an uncommitted offset only means a replay, which
		// the request_id conflict check turns into a no-op.
		log.Printf("worker: commit offsets failed: %v", err)
	}
	return true
}

// insertIndividually rescues a batch containing a row Postgres will never
// accept, e.g. a bid on an item someone deleted by hand. Retrying the batch
// could never succeed: every later bid on every item would wait behind it
// forever, even across worker restarts. The good rows are written and the bad
// one goes to audit_log as bid.dropped. Returns false on a transient failure,
// so the caller retries (rows already written are no-ops per request_id).
func (w *Worker) insertIndividually(ctx context.Context, inserts []db.BidInsert) bool {
	for _, ins := range inserts {
		err := db.BatchInsertBids(ctx, w.pool, []db.BidInsert{ins})
		if err == nil {
			continue
		}
		if !db.IsPermanent(err) {
			log.Printf("worker: write of bid %s failed, offsets NOT committed (will retry): %v", ins.RequestID, err)
			return false
		}
		log.Printf("worker: dropping bid %s on item %s: %v", ins.RequestID, ins.ItemID, err)
		details := fmt.Sprintf("request_id=%s user_id=%s amount=%.2f status=%s error=%v", ins.RequestID, ins.UserID, ins.Amount, ins.Status, err)
		if err := db.LogAudit(ctx, w.pool, "", "bid.dropped", "item", ins.ItemID, details, ""); err != nil {
			log.Printf("worker: record dropped bid %s failed (will retry): %v", ins.RequestID, err)
			return false
		}
		metrics.BidsDroppedTotal.Inc()
		if db.IsMissingItem(err) {
			// Stops further bids being accepted for an item that is gone. A bid
			// being adjudicated right now can recreate the key; its own failed
			// write ends up back here and removes it again.
			if err := redisstate.Delete(ctx, w.rdb, ins.ItemID); err != nil {
				log.Printf("worker: remove redis state of deleted item %s: %v", ins.ItemID, err)
			}
		}
	}
	return true
}
