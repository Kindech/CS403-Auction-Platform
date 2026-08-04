package worker

import (
	"context"
	"log"
	"time"

	kafka "github.com/segmentio/kafka-go"
	"github.com/redis/go-redis/v9"
	"github.com/jackc/pgx/v5/pgxpool"

	"auction/backend/internal/config"
	"auction/backend/internal/db"
	"auction/backend/internal/decision"
	"auction/backend/internal/kafkabus"
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
			if len(buffer) >= w.cfg.BatchSize {
				w.flush(ctx, buffer)
				buffer = nil
			}

		case <-flushTicker.C:
			if len(buffer) > 0 {
				w.flush(ctx, buffer)
				buffer = nil
			}

		case <-lifecycleTicker.C:
			w.runLifecycle(ctx)
		}
	}
}

// handleBid adjudicates one bid: read state, decide, write state, notify.
// It never touches Postgres directly - that happens in flush() so a slow
// disk write can never add latency to the real-time broadcast path.
func (w *Worker) handleBid(ctx context.Context, req models.BidRequest) db.BidInsert {
	state, ok, err := redisstate.Get(ctx, w.rdb, req.ItemID)
	if err != nil {
		log.Printf("worker: redis get failed for item %s: %v", req.ItemID, err)
		return db.BidInsert{ItemID: req.ItemID, UserID: req.UserID, Amount: req.Amount, Status: models.BidRejected, Reason: "internal_error", At: req.Timestamp}
	}
	if !ok {
		w.notifier.NotifyAll(notifyEvent{Type: "bid_rejected", ItemID: req.ItemID, TargetUserID: req.UserID, Reason: "auction_not_live"})
		return db.BidInsert{ItemID: req.ItemID, UserID: req.UserID, Amount: req.Amount, Status: models.BidRejected, Reason: "auction_not_live", At: req.Timestamp}
	}

	out := decision.Decide(state, req.UserID, req.UserName, req.Amount, req.Timestamp.UnixMilli(),
		w.cfg.AntiSnipeWindow.Milliseconds(), w.cfg.AntiSnipeExtension.Milliseconds())

	if !out.Accepted {
		w.notifier.NotifyAll(notifyEvent{Type: "bid_rejected", ItemID: req.ItemID, TargetUserID: req.UserID, Reason: out.Reason})
		return db.BidInsert{ItemID: req.ItemID, UserID: req.UserID, Amount: req.Amount, Status: models.BidRejected, Reason: out.Reason, At: req.Timestamp}
	}

	if err := redisstate.Set(ctx, w.rdb, out.NewState); err != nil {
		log.Printf("worker: redis set failed for item %s: %v", req.ItemID, err)
	}

	w.notifier.NotifyAll(notifyEvent{
		Type: "price_update", ItemID: req.ItemID,
		Price: out.NewState.Price, BidderName: out.NewState.BidderName,
		EndTimeMs: out.NewState.EndTimeMs, MinIncrement: out.NewState.MinIncrement,
		SoftExtended: out.SoftExtended,
	})

	if out.SoftExtended {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if err := db.ExtendItemEndTime(ctx, w.pool, req.ItemID, time.UnixMilli(out.NewState.EndTimeMs)); err != nil {
				log.Printf("worker: persist anti-snipe extension for item %s: %v", req.ItemID, err)
			}
		}()
	}

	return db.BidInsert{ItemID: req.ItemID, UserID: req.UserID, Amount: req.Amount, Status: models.BidAccepted, At: req.Timestamp}
}

// flush durably writes the audit batch to Postgres and only then commits
// Kafka offsets - the invariant that makes worker crashes lossless (report
// section 2.6.4: "at-least-once processing via offset commit").
func (w *Worker) flush(ctx context.Context, buffer []pendingInsert) {
	if len(buffer) == 0 {
		return
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
		log.Printf("worker: batch insert failed, offsets NOT committed (will replay): %v", err)
		return
	}
	if err := w.consumer.CommitOffset(writeCtx, msgs...); err != nil {
		log.Printf("worker: commit offsets failed: %v", err)
	}
}
