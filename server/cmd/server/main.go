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
	awskms "github.com/aws/aws-sdk-go-v2/service/kms"
	awss3 "github.com/aws/aws-sdk-go-v2/service/s3"

	"circle-relay/internal/api"
	"circle-relay/internal/api/auth/oidcverify"
	"circle-relay/internal/config"
	kmssecrets "circle-relay/internal/secrets/kms"
	authdynamodb "circle-relay/internal/storage/authstore/dynamodb"
	blobs3 "circle-relay/internal/storage/blobstore/s3"
	logdynamodb "circle-relay/internal/storage/logstore/dynamodb"
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

	authStore := authdynamodb.New(awsdynamodb.NewFromConfig(awsCfg), cfg.DevicesTableName)
	secretStore, err := kmssecrets.New(awskms.NewFromConfig(awsCfg), cfg.RootSecretCiphertext)
	if err != nil {
		log.Fatalf("failed to construct root secret store: %v", err)
	}
	googleVerifier := oidcverify.New(googleIssuer, googleJWKSURL, cfg.GoogleClientIDs)
	appleVerifier := oidcverify.New(appleIssuer, appleJWKSURL, cfg.AppleClientIDs)

	mux := api.NewRouter(logStore, blobStore, authStore, secretStore, googleVerifier, appleVerifier)

	addr := ":" + cfg.Port
	log.Printf("listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}
