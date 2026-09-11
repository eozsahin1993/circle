// Package app wires the real AWS adapters into api.Deps — the one place
// cmd/server and cmd/lambda both build the relay, so a wiring mistake in
// one can't go unnoticed in the other.
package app

import (
	"context"
	"fmt"
	"net/http"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	awsdynamodb "github.com/aws/aws-sdk-go-v2/service/dynamodb"
	awss3 "github.com/aws/aws-sdk-go-v2/service/s3"

	"circle-relay/internal/api"
	"circle-relay/internal/api/auth/oidcverify"
	"circle-relay/internal/api/push"
	"circle-relay/internal/config"
	"circle-relay/internal/push/apns"
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

	fcmDispatch := fcm.NewDispatcher(awsCfg, cfg.FCMCredentialParameter, cfg.FCMCredentialFile)
	apnsDispatch := apns.NewDispatcher(awsCfg, cfg.APNSAuthKeyParameter, cfg.APNSAuthKeyFile, cfg.APNSKeyID, cfg.APNSTeamID, cfg.APNSTopic, cfg.APNSProduction)

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
			// Each dispatcher gates on its own platform internally (see
			// fcm.NewDispatcher/apns.NewDispatcher), so calling both is a
			// no-op for whichever one a delivery isn't for.
			Dispatch: func(delivery push.Delivery, keyVersion int64, payload []byte) {
				fcmDispatch(delivery, keyVersion, payload)
				apnsDispatch(delivery, keyVersion, payload)
			},
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
