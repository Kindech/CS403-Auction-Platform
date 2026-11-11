package httpapi

import (
	"errors"
	"io"
	"log"
	"net/http"

	"auction/backend/internal/db"
	"auction/backend/internal/imagestore"
)

// handleUploadImage takes one photo as multipart field "file", stores it in
// the object store and returns {"url": "/images/items/<random>.jpg"}. The
// seller then lists the returned URLs in image_urls when creating the item.
// The type is decided from the file's bytes, not its name or the header the
// browser sent, so an HTML or SVG file can't be served back as an "image".
func (s *Server) handleUploadImage(w http.ResponseWriter, r *http.Request) {
	if s.images == nil {
		writeError(w, http.StatusServiceUnavailable, "image upload is not configured")
		return
	}
	// room for the multipart headers around the file itself
	r.Body = http.MaxBytesReader(w, r.Body, imagestore.MaxBytes+64<<10)
	file, _, err := r.FormFile("file")
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeError(w, http.StatusRequestEntityTooLarge, "image is larger than 8 MB")
			return
		}
		writeError(w, http.StatusBadRequest, `send the image as multipart form field "file"`)
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, imagestore.MaxBytes+1))
	if err != nil {
		writeError(w, http.StatusBadRequest, "could not read the image")
		return
	}
	if len(data) > imagestore.MaxBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "image is larger than 8 MB")
		return
	}

	url, err := s.images.Put(r.Context(), data)
	switch {
	case errors.Is(err, imagestore.ErrUnsupportedType):
		writeError(w, http.StatusUnsupportedMediaType, "only JPEG, PNG, WebP and GIF images are accepted")
		return
	case errors.Is(err, imagestore.ErrNotReady):
		writeError(w, http.StatusServiceUnavailable, "image storage is starting, try again in a moment")
		return
	case err != nil:
		log.Printf("upload image: %v", err)
		writeError(w, http.StatusServiceUnavailable, "image storage is unavailable")
		return
	}
	claims, _ := claimsFrom(r)
	_ = db.LogAudit(r.Context(), s.pool, claims.UserID, "image.upload", "image", url, "", r.RemoteAddr)
	writeJSON(w, http.StatusCreated, map[string]string{"url": url})
}
