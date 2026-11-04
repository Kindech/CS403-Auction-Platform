package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestValidateRegistration(t *testing.T) {
	ok := registerRequest{Email: "a@example.com", Password: "password123", DisplayName: "Ann"}
	cases := []struct {
		name  string
		edit  func(*registerRequest)
		valid bool
	}{
		{"fine", func(*registerRequest) {}, true},
		{"72 byte password", func(r *registerRequest) { r.Password = strings.Repeat("a", 72) }, true},
		{"73 byte password", func(r *registerRequest) { r.Password = strings.Repeat("a", 73) }, false},
		{"short password", func(r *registerRequest) { r.Password = "12345" }, false},
		{"not an email", func(r *registerRequest) { r.Email = "notanemail" }, false},
		{"name and address", func(r *registerRequest) { r.Email = "Ann <a@example.com>" }, false},
		{"no display name", func(r *registerRequest) { r.DisplayName = "" }, false},
		{"long display name", func(r *registerRequest) { r.DisplayName = strings.Repeat("ก", 101) }, false},
	}
	for _, c := range cases {
		req := ok
		c.edit(&req)
		if got := validateRegistration(req) == ""; got != c.valid {
			t.Errorf("%s: valid = %v, want %v (%q)", c.name, got, c.valid, validateRegistration(req))
		}
	}
}

func TestValidateItem(t *testing.T) {
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	ok := createItemRequest{Title: "Watch", StartingPrice: 100, BidIncrement: 10, StartTime: now, EndTime: now.Add(time.Hour)}
	cases := []struct {
		name  string
		edit  func(*createItemRequest)
		valid bool
	}{
		{"fine", func(*createItemRequest) {}, true},
		{"no image", func(r *createItemRequest) { r.ImageURL = "" }, true},
		{"https image", func(r *createItemRequest) { r.ImageURL = "https://example.com/a.png" }, true},
		{"javascript image", func(r *createItemRequest) { r.ImageURL = "javascript:alert(1)" }, false},
		{"empty title", func(r *createItemRequest) { r.Title = "" }, false},
		{"huge title", func(r *createItemRequest) { r.Title = strings.Repeat("x", 201) }, false},
		{"huge description", func(r *createItemRequest) { r.Description = strings.Repeat("x", 5001) }, false},
		{"price overflows the column", func(r *createItemRequest) { r.StartingPrice = 1e15 }, false},
		{"price with 3 decimals", func(r *createItemRequest) { r.StartingPrice = 1.234 }, false},
		{"zero increment", func(r *createItemRequest) { r.BidIncrement = 0 }, false},
		{"no start time", func(r *createItemRequest) { r.StartTime = time.Time{} }, false},
		{"end before start", func(r *createItemRequest) { r.EndTime = now.Add(-time.Minute) }, false},
		{"already over", func(r *createItemRequest) {
			r.StartTime, r.EndTime = now.Add(-2*time.Hour), now.Add(-time.Hour)
		}, false},
	}
	for _, c := range cases {
		req := ok
		c.edit(&req)
		if got := validateItem(req, now) == ""; got != c.valid {
			t.Errorf("%s: valid = %v, want %v (%q)", c.name, got, c.valid, validateItem(req, now))
		}
	}
}

func TestRealIPFromProxy(t *testing.T) {
	var got string
	h := realIPFromProxy(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) { got = r.RemoteAddr }))

	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "172.19.0.8:40000"
	r.Header.Set("X-Real-IP", "203.0.113.9")
	r.Header.Set("True-Client-IP", "1.2.3.4") // not set by nginx, so a client could spoof it
	h.ServeHTTP(httptest.NewRecorder(), r)
	if got != "203.0.113.9" {
		t.Errorf("RemoteAddr = %q", got)
	}
}

func TestRedactTokenFromLogs(t *testing.T) {
	var uri, token string
	h := redactTokenFromLogs(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		uri, token = r.RequestURI, r.URL.Query().Get("token")
	}))

	r := httptest.NewRequest(http.MethodGet, "/ws/auctions/1?token=secret", nil)
	h.ServeHTTP(httptest.NewRecorder(), r)
	if strings.Contains(uri, "secret") {
		t.Errorf("token still in RequestURI: %q", uri)
	}
	if token != "secret" {
		t.Errorf("handler lost the token: %q", token)
	}
}
