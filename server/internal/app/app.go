// Package app wires the real AWS adapters into api.Deps — the one place
// cmd/server and cmd/lambda both build the relay, so a wiring mistake in
// one can't go unnoticed in the other.
package app

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	awsdynamodb "github.com/aws/aws-sdk-go-v2/service/dynamodb"
	awss3 "github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/ssm"

	"circle-relay/internal/api"
	"circle-relay/internal/api/auth/oidcverify"
	"circle-relay/internal/api/push"
	"circle-relay/internal/config"
	"circle-relay/internal/push/fcm"

	authdynamodb "circle-relay/internal/storage/authstore/dynamodb"
	blobs3 "circle-relay/internal/storage/blobstore/s3"
	invitedynamodb "circle-relay/internal/storage/invitestore/dynamodb"
	logdynamodb "circle-relay/internal/storage/logstore/dynamodb"
	manifestdynamodb "circle-relay/internal/storage/manifeststore/dynamodb"
	pushdynamodb "circle-relay/internal/storage/pushstore/dynamodb"
	ratelimitdynamodb "circle-relay/internal/storage/ratelimitstore/dynamodb"
)

const (
	googleIssuer  = "https://accounts.google.com"
	googleJWKSURL = "https://www.googleapis.com/oauth2/v3/certs"
	appleIssuer   = "https://appleid.apple.com"
	appleJWKSURL  = "https://appleid.apple.com/auth/keys"
)

// New returns the relay's handler, wired to real DynamoDB and S3 from the
// ambient AWS configuration. Returns an error rather than exiting, so a
// caller that isn't a `main` — a test, say — gets to decide.
func New(ctx context.Context, cfg config.Config) (*http.ServeMux, error) {
	awsCfg, err := awsconfig.LoadDefaultConfig(ctx)
	if err != nil {
		return nil, fmt.Errorf("load AWS config: %w", err)
	}
	return api.NewRouter(Deps(cfg, awsCfg)), nil
}

// Deps builds the real AWS-backed dependencies, separate from New so a
// caller with its own aws.Config — LocalStack, say — gets this wiring
// rather than a copy of it. See cmd/testrelay, which also needs the
// stores directly to mint sessions.
func Deps(cfg config.Config, awsCfg aws.Config) api.Deps {
	dynamo := func() *awsdynamodb.Client { return awsdynamodb.NewFromConfig(awsCfg) }
	// Applied here, not per-binary: cmd/lambda never read this flag before,
	// silently ignoring it.
	s3Client := awss3.NewFromConfig(awsCfg, func(o *awss3.Options) { o.UsePathStyle = cfg.S3ForcePathStyle })

	limit := func(kind string, max int64) *ratelimitdynamodb.Store {
		return ratelimitdynamodb.New(dynamo(), cfg.RateLimitTableName, kind, int(max), cfg.RateLimitWindow())
	}

	return api.Deps{
		Log:        logdynamodb.New(dynamo(), cfg.TableName),
		Blob:       blobs3.New(s3Client, cfg.BucketName, cfg.MaxBlobSize),
		Auth:       authdynamodb.New(dynamo(), cfg.SessionsTableName),
		Manifest:   manifestdynamodb.New(dynamo(), cfg.AccountsTableName),
		Invite:     invitedynamodb.New(dynamo(), cfg.InviteTableName, cfg.InviteRetentionDays),
		WriteLimit: limit("write", cfg.RateLimitWriteMaxRequests),
		ReadLimit:  limit("read", cfg.RateLimitReadMaxRequests),
		Google:     oidcverify.New(googleIssuer, googleJWKSURL, nonEmpty(cfg.GoogleClientIDIOS, cfg.GoogleClientIDAndroid, cfg.GoogleClientIDWeb)),
		Apple:      oidcverify.New(appleIssuer, appleJWKSURL, nonEmpty(cfg.AppleClientIDIOS)),
		Push: api.PushDeps{
			Store:          pushdynamodb.New(dynamo(), cfg.PushTableName),
			RecipientLimit: limit("push", cfg.RateLimitPushMaxRequests),
			Dispatch:       pushDispatcher(awsCfg, cfg.FCMCredentialParameter, cfg.FCMCredentialFile),
		},
	}
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

// pushDispatcher delivers resolved pushes. The credential is fetched on the
// first send rather than at boot, so a relay without one still serves every
// other route — push is the only thing that needs it.
//
// Fire-and-forget by design: a push is best-effort, and a failed one must
// not fail the append that triggered it.
func pushDispatcher(awsCfg aws.Config, parameterName, filePath string) func(push.Delivery, int64, []byte) {
	loader := &fcm.Loader{
		Client:        ssm.NewFromConfig(awsCfg),
		ParameterName: parameterName,
		FilePath:      filePath,
	}
	var (
		once   sync.Once
		sender *fcm.Sender
	)

	return func(delivery push.Delivery, keyVersion int64, payload []byte) {
		// iOS goes direct to APNs, which isn't built yet.
		if delivery.Platform != "android" {
			return
		}

		ctx := context.Background()
		once.Do(func() {
			account, err := loader.Load(ctx)
			if err != nil {
				log.Printf("push disabled: %v", err)
				return
			}
			sender = fcm.New(account)
		})
		if sender == nil {
			return
		}

		if err := sender.Send(ctx, string(delivery.PushToken), delivery.PushRoutingID, keyVersion, payload); err != nil {
			log.Printf("failed to deliver a push: %v", err)
		}
	}
}
