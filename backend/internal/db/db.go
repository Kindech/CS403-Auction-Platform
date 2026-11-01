package db

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Connect opens a pool of at most maxConns connections. Every running
// api-server and bid-worker holds its own pool, so the sum over all of them
// - including every pod an autoscaler may add - has to stay under
// Postgres's max_connections (100 by default), or the extra connection
// attempts fail with "too many clients" and requests return 500.
func Connect(ctx context.Context, url string, maxConns int) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, err
	}
	cfg.MaxConns = int32(maxConns)
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
