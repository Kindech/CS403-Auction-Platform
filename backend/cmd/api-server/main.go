package main

import (
	"context"
	"log"
	"net/http"

	"auction/backend/internal/config"
	"auction/backend/internal/db"
	"auction/backend/internal/httpapi"
	"auction/backend/internal/kafkabus"
	"auction/backend/internal/models"
	"auction/backend/internal/redisstate"
	"auction/backend/internal/ws"
	"auction/backend/migrations"
)

func main() {
	cfg := config.Load()
	ctx := context.Background()

	pool, err := db.Connect(ctx, cfg.PostgresURL)
	if err != nil {
		log.Fatalf("connect postgres: %v", err)
	}
	defer pool.Close()

	if err := db.Migrate(ctx, pool, migrations.FS); err != nil {
		log.Fatalf("migrate postgres: %v", err)
	}

	rdb := redisstate.New(cfg.RedisAddr)
	defer rdb.Close()

	producer := kafkabus.NewProducer(cfg.KafkaBrokers, cfg.KafkaTopic)
	defer producer.Close()

	hub := ws.NewHub()
	wsDeps := &ws.Deps{
		Hub:            hub,
		JWTSecret:      cfg.JWTSecret,
		InternalSecret: cfg.InternalSecret,
		Redis:          rdb,
		Producer:       producer,
		GetItem: func(ctx context.Context, itemID string) (models.Item, error) {
			return db.GetItem(ctx, pool, itemID)
		},
		RateLimitPerSec: cfg.BidRateLimitPerSec,
	}

	server := httpapi.NewServer(cfg, pool, rdb, wsDeps)

	log.Printf("api-server listening on %s (rate limit %d bids/sec/conn)", cfg.HTTPAddr, cfg.BidRateLimitPerSec)
	if err := http.ListenAndServe(cfg.HTTPAddr, server.Router()); err != nil {
		log.Fatalf("http server: %v", err)
	}
}
