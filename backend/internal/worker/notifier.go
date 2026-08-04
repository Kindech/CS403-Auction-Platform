// Package worker implements the "Bid Worker" from the report: it consumes
// bid requests from Kafka one at a time (sequential, per the architecture's
// single-consumer-per-partition rule), adjudicates them against Redis,
// notifies every api-server instance directly (no Redis Pub/Sub), and
// asynchronously batches the audit trail into Postgres, only committing the
// Kafka offset once that batch is durably written.
package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"
)

type notifyEvent struct {
	Type         string  `json:"type"`
	ItemID       string  `json:"item_id"`
	Price        float64 `json:"price,omitempty"`
	BidderName   string  `json:"bidder_name,omitempty"`
	EndTimeMs    int64   `json:"end_time_ms,omitempty"`
	MinIncrement float64 `json:"min_increment,omitempty"`
	SoftExtended bool    `json:"soft_extended,omitempty"`
	TargetUserID string  `json:"target_user_id,omitempty"`
	Reason       string  `json:"reason,omitempty"`
	WinnerName   string  `json:"winner_name,omitempty"`
	FinalPrice   float64 `json:"final_price,omitempty"`
}

type Notifier struct {
	peers  []string
	secret string
	client *http.Client
}

func NewNotifier(peers []string, secret string) *Notifier {
	return &Notifier{peers: peers, secret: secret, client: &http.Client{Timeout: 2 * time.Second}}
}

// NotifyAll is fire-and-forget on purpose: an api-server instance being
// briefly unreachable must never block bid adjudication or Kafka offset
// progress. Its own connected clients simply resync via the "sync" event
// they get whenever they (re)connect.
func (n *Notifier) NotifyAll(ev notifyEvent) {
	payload, err := json.Marshal(ev)
	if err != nil {
		log.Printf("worker: marshal notify event: %v", err)
		return
	}
	for _, peer := range n.peers {
		go func(url string) {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			req, err := http.NewRequestWithContext(ctx, http.MethodPost, url+"/internal/events", bytes.NewReader(payload))
			if err != nil {
				return
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-Internal-Secret", n.secret)
			resp, err := n.client.Do(req)
			if err != nil {
				log.Printf("worker: notify %s failed: %v", url, err)
				return
			}
			resp.Body.Close()
		}(peer)
	}
}
