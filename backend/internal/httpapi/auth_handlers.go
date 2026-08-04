package httpapi

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"auction/backend/internal/auth"
	"auction/backend/internal/db"
)

const tokenTTL = 24 * time.Hour

type registerRequest struct {
	Email       string `json:"email"`
	Password    string `json:"password"`
	DisplayName string `json:"display_name"`
}

type authResponse struct {
	Token string      `json:"token"`
	User  userPayload `json:"user"`
}

type userPayload struct {
	ID          string `json:"id"`
	Email       string `json:"email"`
	DisplayName string `json:"display_name"`
}

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	var req registerRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	req.Email = strings.ToLower(strings.TrimSpace(req.Email))
	req.DisplayName = strings.TrimSpace(req.DisplayName)
	if req.Email == "" || len(req.Password) < 6 || req.DisplayName == "" {
		writeError(w, http.StatusBadRequest, "email, display_name and password (min 6 chars) are required")
		return
	}

	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not hash password")
		return
	}

	u, err := db.CreateUser(r.Context(), s.pool, req.Email, hash, req.DisplayName)
	if err != nil {
		writeError(w, http.StatusConflict, "email already registered")
		return
	}

	token, err := auth.IssueToken(s.cfg.JWTSecret, u.ID, u.DisplayName, tokenTTL)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not issue token")
		return
	}
	writeJSON(w, http.StatusCreated, authResponse{Token: token, User: userPayload{u.ID, u.Email, u.DisplayName}})
}

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	req.Email = strings.ToLower(strings.TrimSpace(req.Email))

	u, err := db.GetUserByEmail(r.Context(), s.pool, req.Email)
	if errors.Is(err, db.ErrNotFound) || (err == nil && !auth.CheckPassword(u.PasswordHash, req.Password)) {
		writeError(w, http.StatusUnauthorized, "invalid email or password")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "login failed")
		return
	}

	token, err := auth.IssueToken(s.cfg.JWTSecret, u.ID, u.DisplayName, tokenTTL)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not issue token")
		return
	}
	writeJSON(w, http.StatusOK, authResponse{Token: token, User: userPayload{u.ID, u.Email, u.DisplayName}})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	claims, _ := claimsFrom(r)
	u, err := db.GetUserByID(r.Context(), s.pool, claims.UserID)
	if err != nil {
		writeError(w, http.StatusNotFound, "user not found")
		return
	}
	writeJSON(w, http.StatusOK, userPayload{u.ID, u.Email, u.DisplayName})
}
