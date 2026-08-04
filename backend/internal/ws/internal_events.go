package ws

import (
	"encoding/json"
	"net/http"
)

// internalEvent mirrors Event but with TargetUserID exported for the JSON
// body bid-worker posts (Event itself hides that field from browser output).
type internalEvent struct {
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

// ServeInternalEvents receives fan-out notifications from bid-worker and
// relays them to this process's locally-connected WS clients.
func (d *Deps) ServeInternalEvents(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("X-Internal-Secret") != d.InternalSecret {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	var in internalEvent
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	d.Hub.SendTo(Event{
		Type:         in.Type,
		ItemID:       in.ItemID,
		Price:        in.Price,
		BidderName:   in.BidderName,
		EndTimeMs:    in.EndTimeMs,
		MinIncrement: in.MinIncrement,
		SoftExtended: in.SoftExtended,
		TargetUserID: in.TargetUserID,
		Reason:       in.Reason,
		WinnerName:   in.WinnerName,
		FinalPrice:   in.FinalPrice,
	})
	w.WriteHeader(http.StatusNoContent)
}
