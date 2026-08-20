package main

import (
	"context"
	"log"
	"net/http"
	"os/signal"
	"syscall"

	"github.com/prometheus/client_golang/prometheus/promhttp"

	"auction/backend/internal/config"
	"auction/backend/internal/db"
	"auction/backend/internal/kafkabus"
	"auction/backend/internal/redisstate"
	"auction/backend/internal/worker"
)

func main() {
	cfg := config.Load()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	pool, err := db.Connect(ctx, cfg.PostgresURL)
	if err != nil {
		log.Fatalf("connect postgres: %v", err)
	}
	defer pool.Close()

	rdb := redisstate.New(cfg.RedisAddr)
	defer rdb.Close()

	consumer := kafkabus.NewConsumer(cfg.KafkaBrokers, cfg.KafkaTopic, cfg.KafkaGroupID)
	defer consumer.Close()

	if len(cfg.PeerInternalURLs) == 0 {
		log.Println("worker: WARNING no PEER_INTERNAL_URLS configured - bids will be adjudicated but never broadcast")
	}
	notifier := worker.NewNotifier(cfg.PeerInternalURLs, cfg.InternalSecret)

	go func() {
		mux := http.NewServeMux()
		mux.Handle("/metrics", promhttp.Handler())
		mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
		log.Printf("bid-worker metrics listening on %s", cfg.MetricsAddr)
		if err := http.ListenAndServe(cfg.MetricsAddr, mux); err != nil {
			log.Printf("bid-worker: metrics server stopped: %v", err)
		}
	}()

	w := worker.New(cfg, pool, rdb, consumer, notifier)
	log.Printf("bid-worker started (group=%s topic=%s anti-snipe=%s/+%s peers=%v)",
		cfg.KafkaGroupID, cfg.KafkaTopic, cfg.AntiSnipeWindow, cfg.AntiSnipeExtension, cfg.PeerInternalURLs)
	w.Run(ctx)
	log.Println("bid-worker shut down")
}
