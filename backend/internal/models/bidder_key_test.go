package models

import "testing"

func TestBidderKey(t *testing.T) {
	a := BidderKey("item-1", "user-1")
	if a == "" || len(a) != 12 {
		t.Fatalf("unexpected key %q", a)
	}
	if BidderKey("item-1", "user-1") != a {
		t.Error("same item and user must give the same key")
	}
	if BidderKey("item-1", "user-2") == a {
		t.Error("different users on one item must differ")
	}
	if BidderKey("item-2", "user-1") == a {
		t.Error("the same user on another item must not be linkable")
	}
	if BidderKey("item-1", "") != "" {
		t.Error("no user, no key")
	}
}
