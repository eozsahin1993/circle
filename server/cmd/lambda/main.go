// Command lambda is the AWS Lambda entry point — the only place Lambda's
// event/response shapes are allowed to appear. It wires the real
// DynamoDB/S3 adapters into the shared api router and hands the whole
// thing to httpadapter, so internal/api and everything it depends on has
// no idea it's running on Lambda at all.
package main

import (
	"context"
	"log"

	"github.com/aws/aws-lambda-go/lambda"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	awsdynamodb "github.com/aws/aws-sdk-go-v2/service/dynamodb"
	awss3 "github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/awslabs/aws-lambda-go-api-proxy/httpadapter"

	"circle-relay/internal/api"
	"circle-relay/internal/api/auth/oidcverify"
	"circle-relay/internal/config"
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

	logStore := logdynamodb.New(awsdynamodb.NewFromConfig(awsCfg), cfg.TableName)
	blobStore := blobs3.New(awss3.NewFromConfig(awsCfg), cfg.BucketName, cfg.MaxBlobSize)

	authStore := authdynamodb.New(awsdynamodb.NewFromConfig(awsCfg), cfg.SessionsTableName)
	manifestStore := manifestdynamodb.New(awsdynamodb.NewFromConfig(awsCfg), cfg.AccountsTableName)
	inviteStore := invitedynamodb.New(awsdynamodb.NewFromConfig(awsCfg), cfg.InviteTableName, cfg.InviteRetentionDays)
	googleVerifier := oidcverify.New(googleIssuer, googleJWKSURL, nonEmpty(cfg.GoogleClientIDIOS, cfg.GoogleClientIDAndroid, cfg.GoogleClientIDWeb))
	appleVerifier := oidcverify.New(appleIssuer, appleJWKSURL, nonEmpty(cfg.AppleClientIDIOS))

	mux := api.NewRouter(logStore, blobStore, authStore, manifestStore, inviteStore, googleVerifier, appleVerifier)

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
