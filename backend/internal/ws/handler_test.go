package ws

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestOriginAllowed(t *testing.T) {
	cases := []struct {
		name, origin, host, allowed string
		want                        bool
	}{
		{"non-browser client", "", "localhost:8080", "http://localhost:8080", true},
		{"same site", "http://localhost:8080", "localhost:8080", "http://localhost:8080", true},
		{"same host behind nginx, which drops the port", "http://localhost:8080", "localhost", "", true},
		{"vite dev server", "http://localhost:5173", "localhost:8080", "", true},
		{"explicitly allowed", "https://app.example.com", "api.example.com", "https://app.example.com", true},
		{"wildcard", "https://evil.example", "localhost", "*", true},
		{"another site", "https://evil.example", "localhost:8080", "http://localhost:8080", false},
		{"malformed origin", "http://%zz", "localhost", "", false},
	}
	for _, c := range cases {
		r := httptest.NewRequest(http.MethodGet, "/ws/auctions/1", nil)
		r.Host = c.host
		if c.origin != "" {
			r.Header.Set("Origin", c.origin)
		}
		if got := originAllowed(r, c.allowed); got != c.want {
			t.Errorf("%s: originAllowed = %v, want %v", c.name, got, c.want)
		}
	}
}
