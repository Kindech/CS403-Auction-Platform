// Package metrics defines the Prometheus metrics shared across api-server
// and bid-worker. All metrics register themselves against the default
// registry via promauto, so any binary that imports this package just needs
// to expose promhttp.Handler() on /metrics for Prometheus to scrape.
package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	// HTTPRequestsTotal counts every REST request api-server serves.
	HTTPRequestsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "auction_http_requests_total",
		Help: "Total HTTP requests handled, by route/method/status.",
	}, []string{"route", "method", "status"})

	// HTTPRequestDuration times every REST request.
	HTTPRequestDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "auction_http_request_duration_seconds",
		Help:    "HTTP request duration in seconds, by route/method.",
		Buckets: prometheus.DefBuckets,
	}, []string{"route", "method"})

	// WSConnectionsActive is a live gauge of currently-open WebSocket
	// connections across all rooms on this api-server instance.
	WSConnectionsActive = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "auction_ws_connections_active",
		Help: "Currently open WebSocket connections on this instance.",
	})

	// WSMessagesSentTotal counts events queued to a WebSocket client.
	WSMessagesSentTotal = promauto.NewCounter(prometheus.CounterOpts{
		Name: "auction_ws_messages_sent_total",
		Help: "WebSocket events queued for delivery to a client on this instance.",
	})

	// WSMessagesDroppedTotal counts events thrown away because the client's
	// send buffer was full (a client reading slower than events arrive):
	// dropping keeps one slow client from holding up everyone else's
	// broadcast. A client that missed one resyncs on its next event or
	// reconnect.
	WSMessagesDroppedTotal = promauto.NewCounter(prometheus.CounterOpts{
		Name: "auction_ws_messages_dropped_total",
		Help: "WebSocket events dropped because the client's send buffer was full.",
	})

	// BidsTotal counts every bid-worker adjudication outcome.
	BidsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "auction_bids_total",
		Help: "Total bids adjudicated, by outcome (accepted/rejected) and reject reason.",
	}, []string{"status", "reason"})

	// ItemsFinalizedTotal counts every auction bid-worker has closed out.
	ItemsFinalizedTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "auction_items_finalized_total",
		Help: "Total auctions finalized, by outcome (sold/unsold).",
	}, []string{"outcome"})

	// BidsDroppedTotal counts bids Postgres permanently refused (e.g. their
	// item was deleted by hand); each one is in audit_log as bid.dropped.
	BidsDroppedTotal = promauto.NewCounter(prometheus.CounterOpts{
		Name: "auction_bids_dropped_total",
		Help: "Total bids that could never be written to Postgres.",
	})

	// RedisStateRepairsTotal counts live items whose Redis state bid-worker
	// fixed from Postgres: "rebuilt" (the key was missing) or "reconciled"
	// (Redis was behind - it lost acknowledged writes in a crash).
	RedisStateRepairsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "auction_redis_state_repairs_total",
		Help: "Live items whose Redis state was rebuilt or corrected from Postgres.",
	}, []string{"kind"})

	// BidProcessingDuration times handleBid end-to-end (Redis read through
	// notify), i.e. the "fast path" latency the report's NFRs are about.
	BidProcessingDuration = promauto.NewHistogram(prometheus.HistogramOpts{
		Name:    "auction_bid_processing_duration_seconds",
		Help:    "bid-worker adjudication latency: Redis read through notify.",
		Buckets: prometheus.ExponentialBuckets(0.0001, 2, 14), // 100µs .. ~1.6s
	})
)
