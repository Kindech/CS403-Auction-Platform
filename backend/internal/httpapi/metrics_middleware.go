package httpapi

import (
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"

	"auction/backend/internal/metrics"
)

// metricsMiddleware records request count/duration per route. It reads the
// matched route pattern (not the raw URL - avoids a "/items/{id}" cardinality
// explosion per distinct item ID) from chi's routing context, which is only
// populated once chi has finished matching, i.e. after next.ServeHTTP returns.
func metricsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ww := chimw.NewWrapResponseWriter(w, r.ProtoMajor)
		next.ServeHTTP(ww, r)

		route := chi.RouteContext(r.Context()).RoutePattern()
		if route == "" {
			route = "unmatched"
		}
		metrics.HTTPRequestsTotal.WithLabelValues(route, r.Method, strconv.Itoa(ww.Status())).Inc()
		metrics.HTTPRequestDuration.WithLabelValues(route, r.Method).Observe(time.Since(start).Seconds())
	})
}
