// Package worker implements the "Bid Worker" from the report: it consumes
// bid requests from Kafka one at a time (sequential, per the architecture's
// single-consumer-per-partition rule), adjudicates them against Redis,
// announces each outcome to every api-server instance over Redis Pub/Sub,
// and asynchronously batches the audit trail into Postgres, only committing
// the Kafka offset once that batch is durably written.
package worker

import (
	"context"
	"log"
	"time"

	"github.com/redis/go-redis/v9"

	"auction/backend/internal/eventbus"
)

type notifyEvent = eventbus.Message

type Notifier struct {
	rdb *redis.Client
}

func NewNotifier(rdb *redis.Client) *Notifier {
	return &Notifier{rdb: rdb}
}

// NotifyAll publishes the event for every api-server to relay to its own
// connected clients. It is called inline from the adjudication loop (a
// PUBLISH costs about as much as the state write right before it), which
// keeps events for an item in decision order - concurrent per-event sends
// could deliver an older price after a newer one. A failure is only logged:
// it must never hold up bid adjudication, and clients recover from a missed
// event on the next one or via the "sync" they get on reconnect.
func (n *Notifier) NotifyAll(ev notifyEvent) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := eventbus.Publish(ctx, n.rdb, ev); err != nil {
		log.Printf("worker: publish %s event for item %s failed: %v", ev.Type, ev.ItemID, err)
	}
}
