package ws

import (
	"context"

	"github.com/redis/go-redis/v9"

	"auction/backend/internal/eventbus"
)

// RelayEvents subscribes to bid-worker's event channel and hands every
// message to this process's locally-connected WS clients. Each api-server
// runs one of these, so however many instances are running all receive
// every event. Blocks until ctx is cancelled.
func (h *Hub) RelayEvents(ctx context.Context, rdb *redis.Client) {
	eventbus.Subscribe(ctx, rdb, func(m eventbus.Message) {
		h.SendTo(Event{
			Type:         m.Type,
			ItemID:       m.ItemID,
			Price:        m.Price,
			BidderName:   m.BidderName,
			EndTimeMs:    m.EndTimeMs,
			MinIncrement: m.MinIncrement,
			SoftExtended: m.SoftExtended,
			TargetUserID: m.TargetUserID,
			Reason:       m.Reason,
			Amount:       m.Amount,
			WinnerName:   m.WinnerName,
			FinalPrice:   m.FinalPrice,
			NameOwnerID:  m.NameOwnerID,
		})
	})
}
