package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	"auction/backend/internal/config"
	"auction/backend/internal/db"
	"auction/backend/internal/httpapi"
	"auction/backend/internal/imagestore"
	"auction/backend/internal/kafkabus"
	"auction/backend/internal/models"
	"auction/backend/internal/redisstate"
	"auction/backend/internal/ws"
	"auction/backend/migrations"
)

func main() {
	cfg := config.Load()
	if cfg.JWTSecret == config.DefaultJWTSecret {
		log.Printf("WARNING: JWT_SECRET is the built-in dev value - set your own before exposing this anywhere")
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	pool, err := db.Connect(ctx, cfg.PostgresURL, cfg.PostgresMaxConns)
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

	// Retried in the background: Kafka being briefly unreachable must not
	// keep api-server from serving.
	go func() {
		for backoff := time.Second; ctx.Err() == nil; backoff = min(backoff*2, 30*time.Second) {
			actx, cancel := context.WithTimeout(ctx, 5*time.Second)
			err := kafkabus.EnsureBidExpiry(actx, cfg.KafkaBrokers, cfg.KafkaTopic, models.BidExpiry)
			cancel()
			if err == nil {
				log.Printf("kafka: topic %s refuses bids older than %s", cfg.KafkaTopic, models.BidExpiry)
				return
			}
			log.Printf("kafka: set bid expiry on topic %s (retrying in %s): %v", cfg.KafkaTopic, backoff, err)
			time.Sleep(backoff)
		}
	}()

	// Item photos. Like Kafka above, the bucket is set up in the background so
	// a slow-starting MinIO only delays uploads, not the whole api-server.
	var images *imagestore.Store
	if cfg.S3Endpoint != "" {
		images, err = imagestore.New(cfg.S3Endpoint, cfg.S3AccessKey, cfg.S3SecretKey, cfg.S3Bucket)
		if err != nil {
			log.Fatalf("image store: %v", err)
		}
		go func() {
			for backoff := time.Second; ctx.Err() == nil; backoff = min(backoff*2, 30*time.Second) {
				actx, cancel := context.WithTimeout(ctx, 5*time.Second)
				err := images.EnsureBucket(actx)
				cancel()
				if err == nil {
					log.Printf("images: bucket %s on %s ready", cfg.S3Bucket, cfg.S3Endpoint)
					return
				}
				log.Printf("images: set up bucket %s (retrying in %s): %v", cfg.S3Bucket, backoff, err)
				time.Sleep(backoff)
			}
		}()
	} else {
		log.Printf("images: S3_ENDPOINT not set, photo upload disabled")
	}

	hub := ws.NewHub()
	go hub.RelayEvents(ctx, rdb)

	wsDeps := &ws.Deps{
		Hub:       hub,
		JWTSecret: cfg.JWTSecret,
		Redis:     rdb,
		Producer:  producer,
		GetItem: func(ctx context.Context, itemID string) (models.Item, error) {
			return db.GetItem(ctx, pool, itemID)
		},
		RateLimitPerSec: cfg.BidRateLimitPerSec,
		AllowedOrigin:   cfg.CORSOrigin,
	}
	go wsDeps.WatchRedis(ctx)

	server := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           httpapi.NewServer(cfg, pool, rdb, wsDeps, images).Router(),
		ReadHeaderTimeout: 10 * time.Second, // a client can't hold a connection by sending headers slowly
		IdleTimeout:       2 * time.Minute,
	}
	serveErr := make(chan error, 1)
	go func() { serveErr <- server.ListenAndServe() }()
	log.Printf("api-server listening on %s (rate limit %d bids/sec/conn)", cfg.HTTPAddr, cfg.BidRateLimitPerSec)

	select {
	case err := <-serveErr:
		log.Fatalf("http server: %v", err)
	case <-ctx.Done():
	}

	// Let in-flight REST requests finish (a rolling update or scale-down sends
	// SIGTERM). WebSockets end with the process and their browsers reconnect
	// to another instance.
	log.Println("api-server shutting down")
	sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(sctx); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Printf("http server shutdown: %v", err)
	}
}
