package httpapi

import (
	"net/http"

	"auction/backend/internal/models"
	"auction/backend/internal/redisstate"
)

// attachLivePrices overlays the authoritative Redis state onto items that
// are currently "live" (Postgres is only updated asynchronously by
// bid-worker's batch writer and only carries the final price once an
// auction has ended), and masks the current bidder's / winner's display
// name for anyone who isn't that person - see models.MaskDisplayName.
func (s *Server) attachLivePrices(r *http.Request, items []models.Item) {
	viewerID := s.optionalUserID(r)
	for i := range items {
		if items[i].Status == models.ItemLive {
			if st, ok, err := redisstate.Get(r.Context(), s.redis, items[i].ID); err == nil && ok {
				items[i].CurrentPrice = st.Price
				items[i].CurrentBidder = st.BidderName
				if st.BidderName != "" && st.BidderID != viewerID {
					items[i].CurrentBidder = models.MaskDisplayName(st.BidderName)
				}
			}
		}
		if items[i].WinnerName != nil && items[i].WinnerID != nil && *items[i].WinnerID != viewerID {
			masked := models.MaskDisplayName(*items[i].WinnerName)
			items[i].WinnerName = &masked
		}
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
