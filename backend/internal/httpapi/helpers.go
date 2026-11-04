package httpapi

import (
	"encoding/json"
	"net/http"
)

// maxBodyBytes caps JSON request bodies. nginx has its own 1 MB limit, but the
// api-server ports can be reached directly too.
const maxBodyBytes = 1 << 20

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func decodeJSON(w http.ResponseWriter, r *http.Request, v interface{}) error {
	defer r.Body.Close()
	return json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes)).Decode(v)
}
