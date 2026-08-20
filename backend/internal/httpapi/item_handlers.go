package httpapi

import (
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"auction/backend/internal/db"
	"auction/backend/internal/models"
)

type createItemRequest struct {
	Title         string    `json:"title"`
	Description   string    `json:"description"`
	ImageURL      string    `json:"image_url"`
	StartingPrice float64   `json:"starting_price"`
	BidIncrement  float64   `json:"bid_increment"`
	StartTime     time.Time `json:"start_time"`
	EndTime       time.Time `json:"end_time"`
}

func (s *Server) handleListItems(w http.ResponseWriter, r *http.Request) {
	items, err := db.ListItems(r.Context(), s.pool)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list items")
		return
	}
	s.attachLivePrices(r, items)
	writeJSON(w, http.StatusOK, items)
}

func (s *Server) handleGetItem(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	item, err := db.GetItem(r.Context(), s.pool, id)
	if errors.Is(err, db.ErrNotFound) {
		writeError(w, http.StatusNotFound, "item not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to get item")
		return
	}
	items := []models.Item{item}
	s.attachLivePrices(r, items)
	writeJSON(w, http.StatusOK, items[0])
}

func (s *Server) handleCreateItem(w http.ResponseWriter, r *http.Request) {
	claims, _ := claimsFrom(r)
	var req createItemRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	if req.Title == "" || req.StartingPrice <= 0 || req.BidIncrement <= 0 || !req.EndTime.After(req.StartTime) {
		writeError(w, http.StatusBadRequest, "title, starting_price, bid_increment and a valid start/end window are required")
		return
	}

	item := models.Item{
		SellerID:      claims.UserID,
		Title:         req.Title,
		Description:   req.Description,
		ImageURL:      req.ImageURL,
		StartingPrice: req.StartingPrice,
		BidIncrement:  req.BidIncrement,
		StartTime:     req.StartTime,
		EndTime:       req.EndTime,
	}
	created, err := db.CreateItem(r.Context(), s.pool, item)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create item")
		return
	}
	_ = db.LogAudit(r.Context(), s.pool, claims.UserID, "item.create", "item", created.ID, created.Title, r.RemoteAddr)

	// If the item is immediately live, initialize its Redis state right away
	// so bids can be accepted before the worker's next lifecycle tick.
	if created.Status == models.ItemLive {
		s.initLiveState(r, created)
	}

	writeJSON(w, http.StatusCreated, created)
}

func (s *Server) handleMyItems(w http.ResponseWriter, r *http.Request) {
	claims, _ := claimsFrom(r)
	items, err := db.ListItemsBySeller(r.Context(), s.pool, claims.UserID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list items")
		return
	}
	s.attachLivePrices(r, items)
	writeJSON(w, http.StatusOK, items)
}

func (s *Server) handleItemBids(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	bids, err := db.ListBidsForItem(r.Context(), s.pool, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list bids")
		return
	}
	viewerID := s.optionalUserID(r)
	for i := range bids {
		if bids[i].UserID != viewerID {
			bids[i].UserName = models.MaskDisplayName(bids[i].UserName)
		}
	}
	writeJSON(w, http.StatusOK, bids)
}

func (s *Server) handleMyBids(w http.ResponseWriter, r *http.Request) {
	claims, _ := claimsFrom(r)
	bids, err := db.ListBidsForUser(r.Context(), s.pool, claims.UserID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list bids")
		return
	}
	writeJSON(w, http.StatusOK, bids)
}
