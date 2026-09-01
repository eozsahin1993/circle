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

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	awsdynamodb "github.com/aws/aws-sdk-go-v2/service/dynamodb"
	awss3 "github.com/aws/aws-sdk-go-v2/service/s3"

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
	s3Client := awss3.NewFromConfig(awsCfg, func(o *awss3.Options) { o.UsePathStyle = cfg.S3ForcePathStyle })
	blobStore := s3.NewBlobStore(s3Client, cfg.BucketName)

	mux := api.NewRouter(logStore, blobStore)

	addr := ":" + cfg.Port
	log.Printf("listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}
