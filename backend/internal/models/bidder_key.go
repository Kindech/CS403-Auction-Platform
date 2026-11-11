package models

import (
	"crypto/sha256"
	"encoding/hex"
)

// BidderKey is a per-item pseudonym for a bidder: the same person gets the
// same key on one item, so the auction page can count distinct bidders and
// group their bids even though names are masked ("B***r" can be two people),
// but a different key on every other item, so it can't link someone's bids
// across auctions the way a user_id would. Derived from the user's UUID,
// which is never shown to other users.
func BidderKey(itemID, userID string) string {
	if userID == "" {
		return ""
	}
	sum := sha256.Sum256([]byte("bidder:" + itemID + ":" + userID))
	return hex.EncodeToString(sum[:6])
}
