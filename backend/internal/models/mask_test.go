package models

import "testing"

func TestMaskDisplayName(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"typical english name", "Beer", "B***r"},
		{"two-word name", "Demo Bidder", "D***r"},
		{"thai name with space", "ปราณี ทองดี", "ป***ี"},
		{"two characters", "Jo", "J*"},
		{"single character", "X", "X*"},
		{"empty stays empty", "", ""},
		{"trims surrounding whitespace first", "  Beer  ", "B***r"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := MaskDisplayName(tc.in)
			if got != tc.want {
				t.Errorf("MaskDisplayName(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}
