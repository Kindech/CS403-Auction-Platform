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
}

// Run is the single sequential adjudication loop. Deliberately
// single-goroutine: it is what makes read-decide-write on an item's Redis
// state race-free without any locking, and it's what makes the lifecycle
// ticker (activate/finalize items) safe to interleave with bid processing
// for the same item.
func (w *Worker) Run(ctx context.Context) {
	msgCh := make(chan fetchResult, 64)
	go func() {
		for {
			req, msg, err := w.consumer.ReadBid(ctx)
			select {
			case msgCh <- fetchResult{req, msg, err}:
			case <-ctx.Done():
				return
			}
			if err != nil {
				return
			}
		}
	}()

	flushTicker := time.NewTicker(w.cfg.BatchInterval)
	defer flushTicker.Stop()
	lifecycleTicker := time.NewTicker(w.cfg.TickInterval)
	defer lifecycleTicker.Stop()

	var buffer []pendingInsert

	for {
		select {
		case <-ctx.Done():
			w.flush(ctx, buffer)
			return

		case res := <-msgCh:
			if res.err != nil {
				log.Printf("worker: fetch error: %v", res.err)
				continue
			}
			ins := w.handleBid(ctx, res.req)
			buffer = append(buffer, pendingInsert{insert: ins, msg: res.msg})
			if len(buffer) >= w.cfg.BatchSize && w.flush(ctx, buffer) {
				buffer = nil
			}

		case <-flushTicker.C:
			// A failed flush keeps its buffer and retries here: dropping it
			// would let the next successful commit move the Kafka offset past
			// those bids, losing them for good. Retrying is safe because
			// BatchInsertBids is idempotent per request_id.
			if len(buffer) > 0 && w.flush(ctx, buffer) {
				buffer = nil
			}

		case <-lifecycleTicker.C:
			w.runLifecycle(ctx)
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
// whether the batch was written; on false the caller keeps it to retry.
func (w *Worker) flush(ctx context.Context, buffer []pendingInsert) bool {
	if len(buffer) == 0 {
		return true
	}
	inserts := make([]db.BidInsert, len(buffer))
	msgs := make([]kafka.Message, len(buffer))
	for i, p := range buffer {
		inserts[i] = p.insert
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
