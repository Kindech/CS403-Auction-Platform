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
	notifier *Notifier

	// While Postgres is failing, lifecycle ticks back off so their timeouts
	// can't keep stalling the adjudication loop they share.
	lifecycleBackoff time.Duration
	lifecycleNextAt  time.Time
}

func New(cfg config.Config, pool *pgxpool.Pool, rdb *redis.Client, consumer *kafkabus.Consumer, notifier *Notifier) *Worker {
	return &Worker{cfg: cfg, pool: pool, rdb: rdb, consumer: consumer, notifier: notifier}
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
// Postgres is kept off this loop: batches go to writeLoop, so a slow or
// down database delays the audit trail, never bid adjudication.
func (w *Worker) Run(ctx context.Context) {
	msgCh := make(chan fetchResult, 64)
	go w.fetchLoop(ctx, msgCh)

	writeCh := make(chan []pendingInsert, writeQueueBatches)
	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		w.writeLoop(ctx, writeCh)
	}()

	flushTicker := time.NewTicker(w.cfg.BatchInterval)
	defer flushTicker.Stop()
	lifecycleTicker := time.NewTicker(w.cfg.TickInterval)
	defer lifecycleTicker.Stop()

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
			} else {
				ins := w.handleBid(ctx, res.req)
				buffer = append(buffer, pendingInsert{insert: ins, msg: res.msg})
			}
			if len(buffer) >= w.cfg.BatchSize {
				enqueue()
			}

		case <-flushTicker.C:
			enqueue()

		case <-lifecycleTicker.C:
			w.runLifecycle(ctx)
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
// It never blocks on Postgres itself - the audit_log/bids writes it kicks
// off run in their own goroutines so a slow disk write can never add
// latency to the real-time broadcast path.
func (w *Worker) handleBid(ctx context.Context, req models.BidRequest) db.BidInsert {
	start := time.Now()
	defer func() { metrics.BidProcessingDuration.Observe(time.Since(start).Seconds()) }()

	reject := func(reason string) db.BidInsert {
		w.notifier.NotifyAll(notifyEvent{Type: "bid_rejected", ItemID: req.ItemID, TargetUserID: req.UserID, Reason: reason})
		w.logBidDecision(req, false, reason)
		return db.BidInsert{RequestID: req.RequestID, ItemID: req.ItemID, UserID: req.UserID, Amount: req.Amount, Status: models.BidRejected, Reason: reason, At: req.Timestamp}
	}

	// The api-server already filters these out; re-checked here because an
	// out-of-range amount would otherwise be accepted into Redis and then
	// fail the whole Postgres batch with a numeric overflow.
	if !models.ValidBidAmount(req.Amount) {
		ins := reject("invalid_amount")
		ins.Amount = 0 // the raw value can't be stored; audit_log details keeps it
		return ins
	}

	state, ok, err := redisstate.Get(ctx, w.rdb, req.ItemID)
	if err != nil {
		log.Printf("worker: redis get failed for item %s: %v", req.ItemID, err)
		w.logBidDecision(req, false, "internal_error")
		return db.BidInsert{RequestID: req.RequestID, ItemID: req.ItemID, UserID: req.UserID, Amount: req.Amount, Status: models.BidRejected, Reason: "internal_error", At: req.Timestamp}
	}
	if !ok {
		return reject("auction_not_live")
	}

	out := decision.Decide(state, req.UserID, req.UserName, req.Amount, req.Timestamp.UnixMilli(),
		w.cfg.AntiSnipeWindow.Milliseconds(), w.cfg.AntiSnipeExtension.Milliseconds())

	if !out.Accepted {
		return reject(out.Reason)
	}

	if err := redisstate.Set(ctx, w.rdb, out.NewState); err != nil {
		log.Printf("worker: redis set failed for item %s: %v", req.ItemID, err)
	}

	w.notifier.NotifyAll(notifyEvent{
		Type: "price_update", ItemID: req.ItemID,
		Price: out.NewState.Price, BidderName: out.NewState.BidderName,
		EndTimeMs: out.NewState.EndTimeMs, MinIncrement: out.NewState.MinIncrement,
		SoftExtended: out.SoftExtended, NameOwnerID: out.NewState.BidderID,
	})
	w.logBidDecision(req, true, "")

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

	return db.BidInsert{RequestID: req.RequestID, ItemID: req.ItemID, UserID: req.UserID, Amount: req.Amount, Status: models.BidAccepted, At: req.Timestamp}
}

// logBidDecision records the bid-adjudication outcome in audit_log - a
// chronological view of every decision the worker makes, separate from
// (and complementary to) the per-item bids table. Fire-and-forget on
// purpose: never let an audit write add latency to bid adjudication.
func (w *Worker) logBidDecision(req models.BidRequest, accepted bool, reason string) {
	action := "bid.accepted"
	details := fmt.Sprintf("amount=%.2f", req.Amount)
	if !accepted {
		action = "bid.rejected"
		details = fmt.Sprintf("amount=%.2f reason=%s", req.Amount, reason)
		metrics.BidsTotal.WithLabelValues("rejected", reason).Inc()
	} else {
		metrics.BidsTotal.WithLabelValues("accepted", "").Inc()
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := db.LogAudit(ctx, w.pool, req.UserID, action, "item", req.ItemID, details, ""); err != nil {
			log.Printf("worker: log audit for item %s: %v", req.ItemID, err)
		}
	}()
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
		log.Printf("worker: batch insert of %d bids failed, offsets NOT committed (will retry): %v", len(inserts), err)
		return false
	}
	if err := w.consumer.CommitOffset(writeCtx, msgs...); err != nil {
		// Rows are durable; an uncommitted offset only means a replay, which
		// the request_id conflict check turns into a no-op.
		log.Printf("worker: commit offsets failed: %v", err)
	}
	return true
}
