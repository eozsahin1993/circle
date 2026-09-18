package httputil

import (
	"log/slog"
	"net/http"
	"time"
)

// LogRequests records one line per request: what was called, how it went,
// and how long it took.
//
// The route pattern, never the path — a path carries syncIds, invite tags
// and push routing ids, and a log is a place they would sit correlatable
// for as long as retention allows. The relay is meant not to know who is
// talking to whom, and its own logs shouldn't undo that.
func LogRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		recorder := &statusRecorder{ResponseWriter: w, status: http.StatusOK}

		next.ServeHTTP(recorder, r)

		// Pattern is empty for a request nothing matched, which is worth
		// seeing as itself: a client calling a route that doesn't exist.
		route := r.Pattern
		if route == "" {
			route = "(no route)"
		}
		slog.InfoContext(r.Context(), "request",
			"method", r.Method,
			"route", route,
			"status", recorder.status,
			"ms", time.Since(started).Milliseconds())
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}
