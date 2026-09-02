// Command server is the "dedicated, always-on" alternative to cmd/lambda —
// same api.NewRouter, same adapters, just served with http.ListenAndServe
// instead of through Lambda/API Gateway. Exists to prove the port/adapter
// split actually buys the portability it's meant to: nothing below
// internal/api changes to support this, only this file exists.
package main

import (
	"context"
	"log"
	"net/http"
	"time"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	awsdynamodb "github.com/aws/aws-sdk-go-v2/service/dynamodb"
	awskms "github.com/aws/aws-sdk-go-v2/service/kms"
	awss3 "github.com/aws/aws-sdk-go-v2/service/s3"

	"circle-relay/internal/api"
	"circle-relay/internal/api/auth/oidcverify"
	"circle-relay/internal/config"
	kmssecrets "circle-relay/internal/secrets/kms"
	authdynamodb "circle-relay/internal/storage/authstore/dynamodb"
	blobs3 "circle-relay/internal/storage/blobstore/s3"
	invitedynamodb "circle-relay/internal/storage/invitestore/dynamodb"
	logdynamodb "circle-relay/internal/storage/logstore/dynamodb"
	manifestdynamodb "circle-relay/internal/storage/manifeststore/dynamodb"
)

const (
	googleIssuer  = "https://accounts.google.com"
	googleJWKSURL = "https://www.googleapis.com/oauth2/v3/certs"
	appleIssuer   = "https://appleid.apple.com"
	appleJWKSURL  = "https://appleid.apple.com/auth/keys"
)

func main() {
	ctx := context.Background()
	cfg := config.Load()

	awsCfg, err := awsconfig.LoadDefaultConfig(ctx)
	if err != nil {
		log.Fatalf("failed to load AWS config: %v", err)
	}

	logStore := logdynamodb.New(awsdynamodb.NewFromConfig(awsCfg), cfg.TableName, cfg.LogRetentionDays)
	s3Client := awss3.NewFromConfig(awsCfg, func(o *awss3.Options) { o.UsePathStyle = cfg.S3ForcePathStyle })
	blobStore := blobs3.New(s3Client, cfg.BucketName, cfg.MaxBlobSize)

	authStore := authdynamodb.New(awsdynamodb.NewFromConfig(awsCfg), cfg.SessionsTableName)
	manifestStore := manifestdynamodb.New(awsdynamodb.NewFromConfig(awsCfg), cfg.AccountsTableName)
	inviteStore := invitedynamodb.New(awsdynamodb.NewFromConfig(awsCfg), cfg.InviteTableName, cfg.InviteRetentionDays)
	secretStore, err := kmssecrets.New(awskms.NewFromConfig(awsCfg), cfg.RootSecretCiphertext)
	if err != nil {
		log.Fatalf("failed to construct root secret store: %v", err)
	}
	googleVerifier := oidcverify.New(googleIssuer, googleJWKSURL, nonEmpty(cfg.GoogleClientIDIOS, cfg.GoogleClientIDAndroid, cfg.GoogleClientIDWeb))
	appleVerifier := oidcverify.New(appleIssuer, appleJWKSURL, nonEmpty(cfg.AppleClientIDIOS))

	mux := api.NewRouter(logStore, blobStore, authStore, secretStore, manifestStore, inviteStore, googleVerifier, appleVerifier)

	addr := ":" + cfg.Port
	log.Printf("listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, logRequests(mux)))
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

// nonEmpty drops any not-yet-configured platform client ID (config.go
// leaves these as "" rather than requiring every platform up front) before
// they reach oidcverify.New's accepted-audience set.
func nonEmpty(values ...string) []string {
	out := make([]string, 0, len(values))
	for _, v := range values {
		if v != "" {
			out = append(out, v)
		}
	}
	return out
}
