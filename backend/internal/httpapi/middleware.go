package httpapi

import (
	"context"
	"net/http"
	"strings"

	"auction/backend/internal/auth"
)

type ctxKey int

const claimsKey ctxKey = 0

func (s *Server) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		h := r.Header.Get("Authorization")
		if !strings.HasPrefix(h, "Bearer ") {
			writeError(w, http.StatusUnauthorized, "missing bearer token")
			return
		}
		token := strings.TrimPrefix(h, "Bearer ")
		claims, err := auth.ParseToken(s.cfg.JWTSecret, token)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "invalid token")
			return
		}
		ctx := context.WithValue(r.Context(), claimsKey, claims)
		next(w, r.WithContext(ctx))
	}
}

func claimsFrom(r *http.Request) (*auth.Claims, bool) {
	c, ok := r.Context().Value(claimsKey).(*auth.Claims)
	return c, ok
}

// optionalUserID returns the caller's user ID if they sent a valid bearer
// token, or "" if they didn't (or it's invalid) - used by public endpoints
// that still need to know "is this viewer the owner of this row" to decide
// whether to mask a display name, without requiring login just to browse.
func (s *Server) optionalUserID(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(h, "Bearer ") {
		return ""
	}
	claims, err := auth.ParseToken(s.cfg.JWTSecret, strings.TrimPrefix(h, "Bearer "))
	if err != nil {
		return ""
	}
	return claims.UserID
}

func corsMiddleware(origin string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
