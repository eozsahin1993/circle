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

	"circle-relay/internal/adapters/dynamodb"
	"circle-relay/internal/adapters/s3"
	"circle-relay/internal/api"
	"circle-relay/internal/config"
)

func main() {
	ctx := context.Background()
	cfg := config.Load()

	awsCfg, err := awsconfig.LoadDefaultConfig(ctx)
	if err != nil {
		log.Fatalf("failed to load AWS config: %v", err)
	}

	logStore := dynamodb.NewLogStore(awsdynamodb.NewFromConfig(awsCfg), cfg.TableName, cfg.RingBufferSize)
	blobStore := s3.NewBlobStore(awss3.NewFromConfig(awsCfg), cfg.BucketName)

	mux := api.NewRouter(logStore, blobStore)

	// NewV2, not New: provision/api_gateway.tf fronts this with an API
	// Gateway HTTP API, which uses the v2.0 Lambda payload format.
	adapter := httpadapter.NewV2(mux)
	lambda.Start(adapter.ProxyWithContext)
}
