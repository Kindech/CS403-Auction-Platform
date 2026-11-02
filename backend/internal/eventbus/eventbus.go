// Package eventbus carries bid-worker's outcome events (price updates,
// rejections, outbid notices, auction end) to every api-server instance over
// Redis Pub/Sub.
//
// It replaced a direct HTTP POST from bid-worker to each api-server listed in
// PEER_INTERNAL_URLS: that list was fixed at deploy time, so an api-server
// added by scaling out (e.g. a Kubernetes HPA) never received events and its
// clients saw a frozen price. With Pub/Sub, bid-worker publishes once and
// however many api-servers are running each subscribe on startup - neither
// side needs to know about the other.
//
// Delivery is at-most-once: a message published while an api-server is
// disconnected from Redis is lost for that instance. That is acceptable here
// because every event carries absolute state (the current price, not a
// delta), so the next event corrects it, and a reconnecting browser gets a
// fresh "sync" from Redis state. The bid decisions themselves stay durable
// in Kafka/Redis/Postgres - this channel only announces them.
package eventbus

import (
	"context"
	"encoding/json"
	"log"

	"github.com/redis/go-redis/v9"
)

// Channel is the single Redis Pub/Sub channel all events go through. Each
// api-server filters by item_id itself (its Hub only has rooms for items its
// own clients are watching), which keeps this to one SUBSCRIBE per instance.
const Channel = "auction:events"

// Message is the wire format between bid-worker and api-server.
type Message struct {
	Type         string  `json:"type"`
	ItemID       string  `json:"item_id"`
	Price        float64 `json:"price,omitempty"`
	BidderName   string  `json:"bidder_name,omitempty"`
	EndTimeMs    int64   `json:"end_time_ms,omitempty"`
	MinIncrement float64 `json:"min_increment,omitempty"`
	SoftExtended bool    `json:"soft_extended,omitempty"`
	TargetUserID string  `json:"target_user_id,omitempty"`
	Reason       string  `json:"reason,omitempty"`
	Amount       float64 `json:"amount,omitempty"` // bid_rejected: the amount that was rejected
	WinnerName   string  `json:"winner_name,omitempty"`
	FinalPrice   float64 `json:"final_price,omitempty"`
	// NameOwnerID: the user ID that BidderName/WinnerName belongs to, so
	// each api-server can mask it for every other viewer in the room.
	NameOwnerID string `json:"name_owner_id,omitempty"`
}

// Publish sends one message to every subscribed api-server.
func Publish(ctx context.Context, rdb *redis.Client, m Message) error {
	payload, err := json.Marshal(m)
	if err != nil {
		return err
	}
	return rdb.Publish(ctx, Channel, payload).Err()
}

// Subscribe calls handle for every message until ctx is cancelled. go-redis
// re-establishes the subscription by itself after a dropped connection, so
// this only returns on shutdown.
func Subscribe(ctx context.Context, rdb *redis.Client, handle func(Message)) {
	sub := rdb.Subscribe(ctx, Channel)
	defer sub.Close()
	go func() {
		<-ctx.Done()
		sub.Close() // closes sub.Channel(), ending the loop below
	}()

	log.Printf("eventbus: subscribed to redis channel %q", Channel)
	for raw := range sub.Channel() {
		var m Message
		if err := json.Unmarshal([]byte(raw.Payload), &m); err != nil {
			log.Printf("eventbus: dropping undecodable message: %v", err)
			continue
		}
		handle(m)
	}
}
