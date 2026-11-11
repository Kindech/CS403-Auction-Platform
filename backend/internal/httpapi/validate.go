package httpapi

import (
	"net/mail"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"auction/backend/internal/models"
)

const (
	maxTitleLen       = 200
	maxDescriptionLen = 5000
	maxImageURLLen    = 2048
	maxImages         = 10
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
	if len(req.ImageURLs) > maxImages {
		return "at most 10 images per item"
	}
	for _, u := range req.ImageURLs {
		if !validImageURL(u) {
			return "image URLs must be uploaded images or http(s) URLs"
		}
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

// uploadedImagePath matches what imagestore.Put returns, and nothing else
// on this site (no "..", no query string).
var uploadedImagePath = regexp.MustCompile(`^/images/items/[0-9a-f]{32}\.(jpg|png|webp|gif)$`)

// validImageURL accepts a photo uploaded through /api/uploads/images or an
// absolute http(s) URL (seed data and older clients link external photos).
func validImageURL(raw string) bool {
	if len(raw) > maxImageURLLen {
		return false
	}
	if uploadedImagePath.MatchString(raw) {
		return true
	}
	u, err := url.Parse(raw)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
}

// normalizeImageURLs merges the legacy single image_url into image_urls and
// drops blanks, so the stored list is never NULL and never has "" in it.
func normalizeImageURLs(single string, list []string) []string {
	out := make([]string, 0, len(list)+1)
	for _, u := range list {
		if u = strings.TrimSpace(u); u != "" {
			out = append(out, u)
		}
	}
	if single = strings.TrimSpace(single); single != "" && len(out) == 0 {
		out = append(out, single)
	}
	return out
}

func coverImage(urls []string) string {
	if len(urls) == 0 {
		return ""
	}
	return urls[0]
}
