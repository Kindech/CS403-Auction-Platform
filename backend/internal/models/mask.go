package models

import "strings"

// MaskDisplayName partially hides a display name for anyone other than its
// owner, eBay-style: first character + "***" + last character (e.g.
// "Beer" -> "B***r", "ปราณี ทองดี" -> "ป***ี"). Short names degrade
// gracefully instead of fully exposing themselves.
func MaskDisplayName(name string) string {
	runes := []rune(strings.TrimSpace(name))
	switch n := len(runes); {
	case n == 0:
		return name
	case n <= 2:
		return string(runes[0]) + "*"
	default:
		return string(runes[0]) + "***" + string(runes[n-1])
	}
}
