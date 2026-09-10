// Command lambda is the AWS Lambda entry point — the only place Lambda's
// event/response shapes are allowed to appear. It wires the real
// DynamoDB/S3 adapters into the shared api router and hands the whole
// thing to httpadapter, so internal/api and everything it depends on has
// no idea it's running on Lambda at all.
package main

import (
	"context"
	"log"
	"sync"

	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	awsdynamodb "github.com/aws/aws-sdk-go-v2/service/dynamodb"
	awss3 "github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	"github.com/awslabs/aws-lambda-go-api-proxy/httpadapter"

	"circle-relay/internal/api"
	"circle-relay/internal/api/auth/oidcverify"
	"circle-relay/internal/api/push"
	"circle-relay/internal/config"
	"circle-relay/internal/fcm"
	"circle-relay/internal/pushcredential"
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

func main() {
	ctx := context.Background()
	cfg := config.Load()

	awsCfg, err := awsconfig.LoadDefaultConfig(ctx)
	if err != nil {
		log.Fatalf("failed to load AWS config: %v", err)
	}

	logStore := logdynamodb.New(awsdynamodb.NewFromConfig(awsCfg), cfg.TableName)
	blobStore := blobs3.New(awss3.NewFromConfig(awsCfg), cfg.BucketName, cfg.MaxBlobSize)

	authStore := authdynamodb.New(awsdynamodb.NewFromConfig(awsCfg), cfg.SessionsTableName)
	manifestStore := manifestdynamodb.New(awsdynamodb.NewFromConfig(awsCfg), cfg.AccountsTableName)
	inviteStore := invitedynamodb.New(awsdynamodb.NewFromConfig(awsCfg), cfg.InviteTableName, cfg.InviteRetentionDays)
	writeRateLimitStore := ratelimitdynamodb.New(awsdynamodb.NewFromConfig(awsCfg), cfg.RateLimitTableName, "write", int(cfg.RateLimitWriteMaxRequests), cfg.RateLimitWindow())
	readRateLimitStore := ratelimitdynamodb.New(awsdynamodb.NewFromConfig(awsCfg), cfg.RateLimitTableName, "read", int(cfg.RateLimitReadMaxRequests), cfg.RateLimitWindow())
	googleVerifier := oidcverify.New(googleIssuer, googleJWKSURL, nonEmpty(cfg.GoogleClientIDIOS, cfg.GoogleClientIDAndroid, cfg.GoogleClientIDWeb))
	appleVerifier := oidcverify.New(appleIssuer, appleJWKSURL, nonEmpty(cfg.AppleClientIDIOS))

	pushStore := pushdynamodb.New(awsdynamodb.NewFromConfig(awsCfg), cfg.PushTableName)
	pushDeps := api.PushDeps{
		Store:          pushStore,
		RecipientLimit: ratelimitdynamodb.New(awsdynamodb.NewFromConfig(awsCfg), cfg.RateLimitTableName, "push", int(cfg.RateLimitPushMaxRequests), cfg.RateLimitWindow()),
		Dispatch:       pushDispatcher(awsCfg, cfg.FCMCredentialParameter),
	}

	mux := api.NewRouter(logStore, blobStore, authStore, manifestStore, inviteStore, writeRateLimitStore, readRateLimitStore, googleVerifier, appleVerifier, pushDeps)

	// NewV2, not New: provision/lambda_url.tf fronts this with a Lambda
	// Function URL, which uses the same v2.0 Lambda payload format as an
	// API Gateway HTTP API.
	adapter := httpadapter.NewV2(mux)
	lambda.Start(adapter.ProxyWithContext)
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
func pushDispatcher(awsCfg aws.Config, parameterName string) func(push.Delivery, []byte) {
	loader := &pushcredential.Loader{Client: ssm.NewFromConfig(awsCfg), ParameterName: parameterName}
	var (
		once   sync.Once
		sender *fcm.Sender
	)

	return func(delivery push.Delivery, payload []byte) {
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

		if err := sender.Send(ctx, string(delivery.PushToken), payload); err != nil {
			log.Printf("failed to deliver a push: %v", err)
		}
	}
}
