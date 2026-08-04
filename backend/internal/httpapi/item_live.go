package httpapi

import (
	"net/http"

	"auction/backend/internal/models"
	"auction/backend/internal/redisstate"
)

// attachLivePrices overlays the authoritative Redis state onto items that
// are currently "live", since Postgres is only updated asynchronously by
// bid-worker's batch writer and only carries the final price once an
// auction has ended.
func (s *Server) attachLivePrices(r *http.Request, items []models.Item) {
	for i := range items {
		if items[i].Status != models.ItemLive {
			continue
		}
		st, ok, err := redisstate.Get(r.Context(), s.redis, items[i].ID)
		if err != nil || !ok {
			continue
		}
		items[i].CurrentPrice = st.Price
		items[i].CurrentBidder = st.BidderName
	}
}

func (s *Server) initLiveState(r *http.Request, item models.Item) {
	_ = redisstate.Init(r.Context(), s.redis, models.AuctionState{
		ItemID:       item.ID,
		Price:        item.StartingPrice,
		MinIncrement: item.BidIncrement,
		EndTimeMs:    item.EndTime.UnixMilli(),
	})
}
