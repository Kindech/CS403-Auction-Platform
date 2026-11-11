package ws

import (
	"encoding/json"
	"testing"

	"auction/backend/internal/models"
)

// Everyone in the room gets the same per-item bidder_key for a bid, but
// only the bidder sees their own name unmasked.
func TestBroadcastAddsBidderKey(t *testing.T) {
	h := NewHub()
	owner := &Client{Send: make(chan []byte, 1), ItemID: "item-1", UserID: "user-1"}
	other := &Client{Send: make(chan []byte, 1), ItemID: "item-1", UserID: "user-2"}
	h.Register(owner)
	h.Register(other)

	h.BroadcastToRoom("item-1", Event{
		Type: EventPriceUpdate, ItemID: "item-1", Price: 120,
		BidderName: "Beer", NameOwnerID: "user-1",
	})

	want := models.BidderKey("item-1", "user-1")
	for _, c := range []struct {
		client *Client
		name   string
	}{{owner, "Beer"}, {other, "B***r"}} {
		var ev Event
		if err := json.Unmarshal(<-c.client.Send, &ev); err != nil {
			t.Fatal(err)
		}
		if ev.BidderKey != want || ev.BidderName != c.name {
			t.Errorf("user %s got key=%q name=%q, want key=%q name=%q", c.client.UserID, ev.BidderKey, ev.BidderName, want, c.name)
		}
	}
}
