package config

import (
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	// shared
	PostgresURL    string
	RedisAddr      string
	KafkaBrokers   []string
	KafkaTopic     string
	JWTSecret      string
	InternalSecret string

	// api-server
	HTTPAddr        string
	SelfInternalURL string   // this instance's own internal URL, used to skip self-notify loops if desired
	PeerInternalURLs []string // other api-server internal URLs to notify (bid-worker only)
	BidRateLimitPerSec int
	CORSOrigin      string

	// bid-worker
	KafkaGroupID       string
	AntiSnipeWindow    time.Duration
	AntiSnipeExtension time.Duration
	BatchSize          int
	BatchInterval      time.Duration
	TickInterval       time.Duration
	MetricsAddr        string // bid-worker's standalone /metrics server (api-server exposes it on HTTPAddr instead)
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}

func getEnvDuration(key string, fallback time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return fallback
}

func splitList(v string) []string {
	if v == "" {
		return nil
	}
	parts := strings.Split(v, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func Load() Config {
	return Config{
		PostgresURL:    getEnv("POSTGRES_URL", "postgres://auction:auction@localhost:5432/auction?sslmode=disable"),
		RedisAddr:      getEnv("REDIS_ADDR", "localhost:6379"),
		KafkaBrokers:   splitList(getEnv("KAFKA_BROKERS", "localhost:9092")),
		KafkaTopic:     getEnv("KAFKA_TOPIC", "bid-requests"),
		JWTSecret:      getEnv("JWT_SECRET", "dev-secret-change-me"),
		InternalSecret: getEnv("INTERNAL_SECRET", "dev-internal-secret-change-me"),

		HTTPAddr:           getEnv("HTTP_ADDR", ":8080"),
		SelfInternalURL:    getEnv("SELF_INTERNAL_URL", ""),
		PeerInternalURLs:   splitList(getEnv("PEER_INTERNAL_URLS", "")),
		BidRateLimitPerSec: getEnvInt("BID_RATE_LIMIT_PER_SEC", 10),
		CORSOrigin:         getEnv("CORS_ORIGIN", "*"),

		KafkaGroupID:       getEnv("KAFKA_GROUP_ID", "bid-worker"),
		AntiSnipeWindow:    getEnvDuration("ANTI_SNIPE_WINDOW", 60*time.Second),
		AntiSnipeExtension: getEnvDuration("ANTI_SNIPE_EXTENSION", 60*time.Second),
		BatchSize:          getEnvInt("BATCH_SIZE", 50),
		BatchInterval:      getEnvDuration("BATCH_INTERVAL", 500*time.Millisecond),
		TickInterval:       getEnvDuration("TICK_INTERVAL", 1*time.Second),
		MetricsAddr:        getEnv("METRICS_ADDR", ":9101"),
	}
}
