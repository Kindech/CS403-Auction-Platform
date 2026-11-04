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
	"auction/backend/internal/eventbus"
	"auction/backend/internal/kafkabus"
	"auction/backend/internal/redisstate"
	"auction/backend/internal/worker"
	"auction/backend/migrations"
)

func main() {
	cfg := config.Load()

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

	consumer := kafkabus.NewConsumer(cfg.KafkaBrokers, cfg.KafkaTopic, cfg.KafkaGroupID)
	defer consumer.Close()

	producer := kafkabus.NewProducer(cfg.KafkaBrokers, cfg.KafkaTopic)
	defer producer.Close()

	notifier := worker.NewNotifier(rdb)

	go func() {
		mux := http.NewServeMux()
		mux.Handle("/metrics", promhttp.Handler())
		mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
		log.Printf("bid-worker metrics listening on %s", cfg.MetricsAddr)
		if err := http.ListenAndServe(cfg.MetricsAddr, mux); err != nil {
			log.Printf("bid-worker: metrics server stopped: %v", err)
		}
	}()

	w := worker.New(cfg, pool, rdb, consumer, producer, notifier)
	log.Printf("bid-worker started (group=%s topic=%s anti-snipe=%s/+%s events=redis:%s)",
		cfg.KafkaGroupID, cfg.KafkaTopic, cfg.AntiSnipeWindow, cfg.AntiSnipeExtension, eventbus.Channel)
	w.Run(ctx)
	log.Println("bid-worker shut down")
}
