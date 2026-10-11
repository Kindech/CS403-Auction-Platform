package models

import (
	"math"
	"testing"
)

func TestValidBidAmount(t *testing.T) {
	cases := []struct {
		amount float64
		want   bool
	}{
		{110, true},
		{0.01, true},
		{MaxBidAmount, true},
		{0, false},
		{-5, false},
		{MaxBidAmount + 1, false},
		{1e13, false}, // overflowed NUMERIC(14,2) and failed the whole batch
		{math.NaN(), false},
		{math.Inf(1), false},
	}
	for _, c := range cases {
		if got := ValidBidAmount(c.amount); got != c.want {
			t.Errorf("ValidBidAmount(%v) = %v, want %v", c.amount, got, c.want)
		}
	}
}

func TestNewUUIDIsUniqueAndWellFormed(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 1000; i++ {
		id := NewUUID()
		if !IsUUID(id) {
			t.Fatalf("NewUUID() = %q, not a valid UUID", id)
		}
		if id[14] != '4' {
			t.Fatalf("NewUUID() = %q, want version 4", id)
		}
		if seen[id] {
			t.Fatalf("NewUUID() returned duplicate %q", id)
		}
		seen[id] = true
	}
}

func TestIsUUID(t *testing.T) {
	for _, s := range []string{"33333333-3333-3333-3333-333333333333", "EA386CCB-E67F-4533-A127-50223F61D899"} {
		if !IsUUID(s) {
			t.Errorf("IsUUID(%q) = false, want true", s)
		}
	}
	for _, s := range []string{"", "not-a-uuid", "33333333333333333333333333333333", "33333333-3333-3333-3333-33333333333g", "33333333-3333-3333-3333-333333333333 "} {
		if IsUUID(s) {
			t.Errorf("IsUUID(%q) = true, want false", s)
		}
	}
}
