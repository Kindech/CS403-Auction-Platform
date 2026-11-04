package ws

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"golang.org/x/time/rate"

	"auction/backend/internal/auth"
	"auction/backend/internal/db"
	"auction/backend/internal/kafkabus"
	"auction/backend/internal/models"
	"auction/backend/internal/redisstate"
	"github.com/redis/go-redis/v9"
)

// How often WatchRedis checks Redis, and how long one check may take.
const (
	redisCheckInterval = 500 * time.Millisecond
	redisCheckTimeout  = time.Second
)

// Deps wires the WS gateway to the rest of api-server without creating an
// import cycle (httpapi -> ws -> {auth,db,kafkabus,redisstate,models} only).
type Deps struct {
	Hub             *Hub
	JWTSecret       string
	Redis           *redis.Client
	Producer        *kafkabus.Producer
	GetItem         func(ctx context.Context, itemID string) (models.Item, error)
	RateLimitPerSec int
	AllowedOrigin   string // CORS_ORIGIN: also accepted for browser WS handshakes

	redisDown atomic.Bool // maintained by WatchRedis
}

// originAllowed is the upgrader's CheckOrigin. A browser always sends Origin,
// so this stops another site's page from opening a socket here; non-browser
// clients (k6, the chaos tests) send none. Only hostnames are compared because
// nginx's "Host $host" drops the port.
func originAllowed(r *http.Request, allowed string) bool {
	origin := r.Header.Get("Origin")
	if origin == "" || allowed == "*" || origin == allowed {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	host := r.Host
	if i := strings.LastIndex(host, ":"); i >= 0 && !strings.HasSuffix(host, "]") {
		host = host[:i]
	}
	return strings.EqualFold(u.Hostname(), strings.Trim(host, "[]"))
}

// ServeWS upgrades GET /ws/auctions/{itemID}?token=... to a WebSocket,
// pushes an initial snapshot (so reconnects always resync to the true current
// state - see TC-07), then relays inbound bids to Kafka.
//
// The token is optional: report §3.2.1 requires that any visitor can watch
// an auction's live price in real time, and only placing a bid requires an
// account. A missing/invalid token connects as an anonymous viewer (empty
// UserID) - readLoop rejects "bid" messages from anonymous connections
// instead of the whole upgrade being refused.
func (d *Deps) ServeWS(itemID string) http.HandlerFunc {
	upgrader := websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool { return originAllowed(r, d.AllowedOrigin) },
	}
	return func(w http.ResponseWriter, r *http.Request) {
		token := r.URL.Query().Get("token")
		var claims auth.Claims
		if token != "" {
			if parsed, err := auth.ParseToken(d.JWTSecret, token); err == nil {
				claims = *parsed
			}
		}

		item, err := d.GetItem(r.Context(), itemID)
		if errors.Is(err, db.ErrNotFound) {
			http.Error(w, "item not found", http.StatusNotFound)
			return
		}
		if err != nil {
			log.Printf("ws: load item %s: %v", itemID, err)
			http.Error(w, "temporarily unavailable", http.StatusServiceUnavailable)
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
			isSeller:    claims.UserID != "" && claims.UserID == item.SellerID,
		}
		client.configureKeepalive()
		d.Hub.Register(client)
		go client.writePump()

		d.sendSnapshot(client, item)

		// Last: once readLoop runs, a disconnect closes client.Send, and the
		// snapshot above must not be sent on a closed channel.
		go d.readLoop(client)
	}
}

// sendSnapshot tells a just-connected client where the auction stands. An
// ended item has no Redis state, so it gets auction_ended instead of sync - a
// browser that was disconnected when the auction closed missed the broadcast
// and would otherwise show it as live forever.
func (d *Deps) sendSnapshot(c *Client, item models.Item) {
	if item.Status == models.ItemEnded {
		ev := Event{Type: EventAuctionEnded, ItemID: item.ID}
		if item.FinalPrice != nil {
			ev.FinalPrice = *item.FinalPrice
		}
		if item.WinnerName != nil {
			ev.WinnerName = *item.WinnerName
			if item.WinnerID == nil || *item.WinnerID != c.UserID {
				ev.WinnerName = models.MaskDisplayName(ev.WinnerName)
			}
		}
		d.Hub.SendToClient(c, ev)
		return
	}

	st, ok, err := redisstate.Get(context.Background(), d.Redis, item.ID)
	if err != nil || !ok {
		return
	}
	bidderName := st.BidderName
	if bidderName != "" && st.BidderID != c.UserID {
		bidderName = models.MaskDisplayName(bidderName)
	}
	d.Hub.SendToClient(c, Event{
		Type:         EventSync,
		ItemID:       item.ID,
		Price:        st.Price,
		BidderName:   bidderName,
		EndTimeMs:    st.EndTimeMs,
		MinIncrement: st.MinIncrement,
	})
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

		if c.isSeller {
			d.Hub.SendToClient(c, Event{
				Type: EventBidRejected, ItemID: c.ItemID, Reason: "seller_cannot_bid", Amount: in.Amount,
			})
			continue
		}

		if !models.ValidBidAmount(in.Amount) {
			d.Hub.SendToClient(c, Event{
				Type: EventBidRejected, ItemID: c.ItemID, Reason: "invalid_amount",
			})
			continue
		}

		// bid-worker needs Redis to decide this bid and to announce the
		// outcome, so with Redis down the bidder would hear nothing. Tell them
		// now, the same way a Kafka outage does (TC-12).
		if d.redisDown.Load() {
			d.Hub.SendToClient(c, Event{
				Type: EventBidRejected, ItemID: c.ItemID, Reason: "service_unavailable", Amount: in.Amount,
			})
			continue
		}

		req := models.BidRequest{
			RequestID: models.NewUUID(),
			ItemID:    c.ItemID,
			UserID:    c.UserID,
			UserName:  c.displayName,
			Amount:    in.Amount,
			Timestamp: time.Now(),
		}
		ctx, cancel := context.WithTimeout(context.Background(), models.BidPublishTimeout)
		if err := d.Producer.PublishBid(ctx, req); err != nil {
			// Tell the bidder instead of failing silently. The Kafka client
			// may still try to deliver this write later (e.g. once a
			// restarting broker is back); the broker then refuses it as too
			// old (models.BidExpiry), so "not recorded" holds either way.
			log.Printf("ws: publish bid failed: %v", err)
			d.Hub.SendToClient(c, Event{
				Type: EventBidRejected, ItemID: c.ItemID, Reason: "service_unavailable", Amount: in.Amount,
			})
		}
		cancel()
	}
}

// WatchRedis keeps redisDown current until ctx is cancelled. The check runs in
// the background rather than per bid so that bids never wait on it: a bid must
// not slow down during a burst, and a ping to a stopped Redis can block for
// seconds. Two misses in a row count as down, so one slow ping from a busy pod
// doesn't turn bids away.
func (d *Deps) WatchRedis(ctx context.Context) {
	ticker := time.NewTicker(redisCheckInterval)
	defer ticker.Stop()
	misses := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		if d.pingRedis() {
			misses = 0
			d.redisDown.Store(false)
		} else if misses++; misses >= 2 {
			d.redisDown.Store(true)
		}
	}
}

// pingRedis gives up after redisCheckTimeout even if the ping itself is stuck
// dialing; the goroutine ends when the dial does.
func (d *Deps) pingRedis() bool {
	ctx, cancel := context.WithTimeout(context.Background(), redisCheckTimeout)
	defer cancel()
	result := make(chan error, 1)
	go func() { result <- d.Redis.Ping(ctx).Err() }()
	select {
	case err := <-result:
		return err == nil
	case <-ctx.Done():
		return false
	}
}
