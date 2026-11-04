package models

import (
	"crypto/rand"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// MaxBidAmount is the largest value the NUMERIC(14,2) money columns can
// hold. Anything above it would make the bids INSERT fail with "numeric
// field overflow" - and take the rest of its batch down with it.
const MaxBidAmount = 999_999_999_999.99

// ValidBidAmount reports whether an amount of money can be adjudicated and
// stored. More than 2 decimals is refused: Postgres would round it, leaving
// 110.126 in Redis but 110.13 in the bids table.
func ValidBidAmount(a float64) bool {
	if math.IsNaN(a) || math.IsInf(a, 0) || a <= 0 || a > MaxBidAmount {
		return false
	}
	s := strconv.FormatFloat(a, 'f', -1, 64) // shortest form that round-trips
	dot := strings.IndexByte(s, '.')
	return dot < 0 || len(s)-dot-1 <= 2
}

// Cents converts a valid amount to whole cents, so comparisons aren't thrown
// off by float rounding (0.1 + 0.2 is more than 0.3 in floats).
func Cents(a float64) int64 {
	return int64(math.Round(a * 100))
}

// NewUUID returns a random (version 4) UUID string.
func NewUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err) // crypto/rand never fails on supported platforms
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// IsUUID reports whether s is a well-formed UUID - checked before handing an
// ID to a UUID column so a malformed one is a 404, not a Postgres error.
func IsUUID(s string) bool {
	return uuidPattern.MatchString(s)
}
