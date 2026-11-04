package httpapi

import (
	"net/mail"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"auction/backend/internal/models"
)

const (
	maxTitleLen       = 200
	maxDescriptionLen = 5000
	maxImageURLLen    = 2048
	maxDisplayNameLen = 100
	minPasswordLen    = 6
	maxPasswordBytes  = 72 // bcrypt refuses anything longer
)

// validateRegistration returns a message for the client, or "" if the request
// is fine. Expects Email and DisplayName to be trimmed already.
func validateRegistration(req registerRequest) string {
	if addr, err := mail.ParseAddress(req.Email); err != nil || addr.Address != req.Email || !strings.Contains(req.Email, "@") {
		return "a valid email address is required"
	}
	if req.DisplayName == "" || utf8.RuneCountInString(req.DisplayName) > maxDisplayNameLen {
		return "display_name is required (max 100 characters)"
	}
	if len(req.Password) < minPasswordLen || len(req.Password) > maxPasswordBytes {
		return "password must be 6 to 72 characters"
	}
	return ""
}

// validateItem returns a message for the client, or "" if the request is fine.
// Expects Title to be trimmed already.
func validateItem(req createItemRequest, now time.Time) string {
	if req.Title == "" || utf8.RuneCountInString(req.Title) > maxTitleLen {
		return "title is required (max 200 characters)"
	}
	if utf8.RuneCountInString(req.Description) > maxDescriptionLen {
		return "description is too long (max 5000 characters)"
	}
	if !validImageURL(req.ImageURL) {
		return "image_url must be an http(s) URL"
	}
	if !models.ValidBidAmount(req.StartingPrice) || !models.ValidBidAmount(req.BidIncrement) {
		return "starting_price and bid_increment must be positive, at most 999,999,999,999.99, with at most 2 decimals"
	}
	if req.StartTime.IsZero() || req.EndTime.IsZero() || !req.EndTime.After(req.StartTime) {
		return "a valid start/end window is required"
	}
	if !req.EndTime.After(now) {
		return "end_time must be in the future"
	}
	return ""
}

func validImageURL(raw string) bool {
	if raw == "" {
		return true
	}
	if len(raw) > maxImageURLLen {
		return false
	}
	u, err := url.Parse(raw)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
}
