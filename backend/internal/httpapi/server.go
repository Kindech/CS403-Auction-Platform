package httpapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/redis/go-redis/v9"

	"auction/backend/internal/config"
	"auction/backend/internal/imagestore"
	"auction/backend/internal/ws"
)

type Server struct {
	cfg   config.Config
	pool  *pgxpool.Pool
	redis *redis.Client
	wsDeps *ws.Deps
	images *imagestore.Store // nil when no object store is configured
}

func NewServer(cfg config.Config, pool *pgxpool.Pool, rdb *redis.Client, wsDeps *ws.Deps, images *imagestore.Store) *Server {
	return &Server{cfg: cfg, pool: pool, redis: rdb, wsDeps: wsDeps, images: images}
}

func (s *Server) Router() http.Handler {
	r := chi.NewRouter()
	r.Use(realIPFromProxy, redactTokenFromLogs, chimw.Logger, chimw.Recoverer, corsMiddleware(s.cfg.CORSOrigin), metricsMiddleware)

	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	r.Handle("/metrics", promhttp.Handler())

	r.Route("/api", func(r chi.Router) {
		r.Post("/auth/register", s.handleRegister)
		r.Post("/auth/login", s.handleLogin)
		r.Get("/me", s.requireAuth(s.handleMe))
		r.Get("/me/bids", s.requireAuth(s.handleMyBids))

		r.Get("/items", s.handleListItems)
		r.Get("/items/mine", s.requireAuth(s.handleMyItems))
		r.Get("/items/{id}", s.handleGetItem)
		r.Get("/items/{id}/bids", s.handleItemBids)
		r.Post("/items", s.requireAuth(s.handleCreateItem))
		r.Post("/uploads/images", s.requireAuth(s.handleUploadImage))
	})

	r.Get("/ws/auctions/{id}", func(w http.ResponseWriter, r *http.Request) {
		s.wsDeps.ServeWS(chi.URLParam(r, "id"))(w, r)
	})

	return r
}
