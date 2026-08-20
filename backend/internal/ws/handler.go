package ws

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
	"golang.org/x/time/rate"

	"auction/backend/internal/auth"
	"auction/backend/internal/kafkabus"
	"auction/backend/internal/models"
	"auction/backend/internal/redisstate"
	"github.com/redis/go-redis/v9"
)

// Deps wires the WS gateway to the rest of api-server without creating an
// import cycle (httpapi -> ws -> {auth,kafkabus,redisstate,models} only).
type Deps struct {
	Hub             *Hub
	JWTSecret       string
	InternalSecret  string
	Redis           *redis.Client
	Producer        *kafkabus.Producer
	GetItem         func(ctx context.Context, itemID string) (models.Item, error)
	RateLimitPerSec int
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true }, // reverse proxy already scopes this
}

// ServeWS upgrades GET /ws/auctions/{itemID}?token=... to a WebSocket,
// pushes an initial "sync" snapshot (so reconnects always resync to the
// true current state - see TC-07), then relays inbound bids to Kafka.
//
// The token is optional: report §3.2.1 requires that any visitor can watch
// an auction's live price in real time, and only placing a bid requires an
// account. A missing/invalid token connects as an anonymous viewer (empty
// UserID) - readLoop rejects "bid" messages from anonymous connections
// instead of the whole upgrade being refused.
func (d *Deps) ServeWS(itemID string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := r.URL.Query().Get("token")
		var claims auth.Claims
		if token != "" {
			if parsed, err := auth.ParseToken(d.JWTSecret, token); err == nil {
				claims = *parsed
			}
		}

		ctx := r.Context()
		if _, err := d.GetItem(ctx, itemID); err != nil {
			http.Error(w, "item not found", http.StatusNotFound)
			return
		}

		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("ws: upgrade failed: %v", err)
			return
		}

		client := &Client{
			Conn:        conn,
			Send:        make(chan []byte, 32),
			ItemID:      itemID,
			UserID:      claims.UserID,
			displayName: claims.DisplayName,
		}
		client.configureKeepalive()
		d.Hub.Register(client)
		go client.writePump()
		go d.readLoop(client)

		if st, ok, err := redisstate.Get(context.Background(), d.Redis, itemID); err == nil && ok {
			d.Hub.SendToClient(client, Event{
				Type:         EventSync,
				ItemID:       itemID,
				Price:        st.Price,
				BidderName:   st.BidderName,
				EndTimeMs:    st.EndTimeMs,
				MinIncrement: st.MinIncrement,
			})
		}
	}
}

func (d *Deps) readLoop(c *Client) {
	defer d.Hub.Unregister(c)

	limiter := rate.NewLimiter(rate.Limit(d.RateLimitPerSec), d.RateLimitPerSec)

	for {
		_, raw, err := c.Conn.ReadMessage()
		if err != nil {
			logClose(c.UserID, c.ItemID, err)
			return
		}

		if !limiter.Allow() {
			d.Hub.SendToClient(c, Event{
				Type: EventBidRejected, ItemID: c.ItemID, Reason: "rate_limited",
			})
			continue
		}

		var in inboundBid
		if err := json.Unmarshal(raw, &in); err != nil || in.Type != "bid" {
			continue
		}

		if c.UserID == "" {
			d.Hub.SendToClient(c, Event{
				Type: EventBidRejected, ItemID: c.ItemID, Reason: "not_authenticated",
			})
			continue
		}

		req := models.BidRequest{
			ItemID:    c.ItemID,
			UserID:    c.UserID,
			UserName:  c.displayName,
			Amount:    in.Amount,
			Timestamp: time.Now(),
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		if err := d.Producer.PublishBid(ctx, req); err != nil {
			log.Printf("ws: publish bid failed: %v", err)
		}
		cancel()
	}
}
