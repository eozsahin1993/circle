// Command testrelay serves the real relay against LocalStack, for tests
// that drive it over HTTP from outside the process — the black-box suite,
// and the headless peer the app's UI tests will need.
//
// Deliberately the same internal/app wiring cmd/server and cmd/lambda use,
// so what these tests exercise is what ships. The only additions are the
// LocalStack endpoints and /testonly/ below, and this binary is never
// deployed: provision/lambda.tf builds cmd/lambda, and nothing builds
// this.
package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"time"

	awsdynamodb "github.com/aws/aws-sdk-go-v2/service/dynamodb"
	awss3 "github.com/aws/aws-sdk-go-v2/service/s3"

	"circle-relay/internal/api"
	"circle-relay/internal/app"
	"circle-relay/internal/config"
	"circle-relay/internal/localstack"
	"circle-relay/internal/storage/authstore"
)

// sessionTTL only has to outlast a test run.
const sessionTTL = time.Hour

func main() {
	ctx := context.Background()

	awsCfg, err := localstack.Config(ctx)
	if err != nil {
		log.Fatalf("failed to configure AWS for LocalStack: %v", err)
	}

	// Idempotent, so restarting this between runs is free and CI needs no
	// separate provisioning step.
	s3Client := awss3.NewFromConfig(awsCfg, func(o *awss3.Options) { o.UsePathStyle = true })
	if err := localstack.Provision(ctx, awsdynamodb.NewFromConfig(awsCfg), s3Client); err != nil {
		log.Fatalf("failed to provision LocalStack: %v", err)
	}

	deps := app.Deps(relayConfig(), awsCfg)
	mux := api.NewRouter(deps)
	registerTestOnly(mux, deps.Auth)

	addr := ":" + port()
	log.Printf("testrelay listening on %s against LocalStack at %s", addr, localstack.Endpoint)
	log.Fatal(http.ListenAndServe(addr, logRequests(mux)))
}

// relayConfig is config.Load's shape without the environment: every value
// is a test value, so a missing variable should be impossible rather than
// fatal. Rate limits stay at their production defaults on purpose — the
// Go suite pins them to a million to keep them out of the way, which
// means nothing exercises the real budgets alongside the router.
func relayConfig() config.Config {
	return config.Config{
		TableName:                 localstack.LogTable,
		BucketName:                localstack.BlobBucket,
		SessionsTableName:         localstack.SessionsTable,
		AccountsTableName:         localstack.AccountsTable,
		InviteTableName:           localstack.InviteTable,
		RateLimitTableName:        localstack.RateLimitTable,
		PushTableName:             localstack.PushTable,
		RateLimitWriteMaxRequests: 500,
		RateLimitReadMaxRequests:  2000,
		RateLimitPushMaxRequests:  500,
		RateLimitWindowMinutes:    10,
		// LocalStack doesn't resolve virtual-hosted-style bucket
		// subdomains, so presigned URLs have to be path style.
		S3ForcePathStyle: true,
	}
}

// Not 8090: that's the port the app's dev relay uses, and a test run
// quietly talking to a hand-started relay — or refusing to bind because
// one is already there — is worse than an explicit choice.
func port() string {
	if p := os.Getenv("PORT"); p != "" {
		return p
	}
	return "8099"
}

// registerTestOnly mounts the one route that doesn't exist in a real
// relay: a session for an account, without a Google or Apple ID token.
//
// A bypass rather than a fake issuer because the alternative is worse —
// standing up a fake OIDC provider here would mean the black-box suite
// testing the fake's JWKS round-trip rather than the relay. Real provider
// verification is covered where it belongs, by internal/api's own tests
// against testsupport.FakeOIDCProvider.
func registerTestOnly(mux *http.ServeMux, sessions authstore.Store) {
	mux.HandleFunc("POST /testonly/session", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			AccountID string `json:"accountId"`
			Token     string `json:"token"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.AccountID == "" || body.Token == "" {
			http.Error(w, `{"error":"accountId and token are both required"}`, http.StatusBadRequest)
			return
		}

		session := authstore.Session{AccountID: body.AccountID, ExpiresAt: time.Now().Add(sessionTTL)}
		if err := sessions.SaveSession(r.Context(), body.Token, session); err != nil {
			http.Error(w, `{"error":"could not save the session"}`, http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
}

// logRequests makes a failing black-box test readable from the relay's
// side without attaching a debugger to it.
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
