// Command server is the "dedicated, always-on" alternative to cmd/lambda —
// the same handler from internal/app, served with http.ListenAndServe
// instead of through Lambda/API Gateway. Exists to prove the port/adapter
// split actually buys the portability it's meant to: nothing below
// internal/api changes to support this, only this file exists.
package main

import (
	"context"
	"log"
	"net/http"
	"time"

	"circle-relay/internal/app"
	"circle-relay/internal/config"
)

func main() {
	cfg := config.Load()

	handler, err := app.New(context.Background(), cfg)
	if err != nil {
		log.Fatalf("failed to build the relay: %v", err)
	}

	addr := ":" + cfg.Port
	log.Printf("listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, logRequests(handler)))
}

// logRequests is local-dev-only — cmd/lambda gets this for free from
// API Gateway/CloudWatch.
func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		log.Printf("%s %s -> %d (%s)", r.Method, r.URL.Path, rec.status, time.Since(start))
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
