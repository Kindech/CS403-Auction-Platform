package db

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func Connect(ctx context.Context, url string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, err
	}
	cfg.MaxConns = 20
	cfg.MaxConnLifetime = time.Hour

	var pool *pgxpool.Pool
	// Retry connecting for a bit: in docker-compose the DB container may
	// still be initializing when this service starts.
	deadline := time.Now().Add(30 * time.Second)
	for {
		pool, err = pgxpool.NewWithConfig(ctx, cfg)
		if err == nil {
			if pingErr := pool.Ping(ctx); pingErr == nil {
				return pool, nil
			} else {
				err = pingErr
				pool.Close()
			}
		}
		if time.Now().After(deadline) {
			return nil, err
		}
		time.Sleep(1 * time.Second)
	}
}
