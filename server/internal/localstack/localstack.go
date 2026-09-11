// Package localstack names the AWS resources a local LocalStack instance
// holds, and creates them.
//
// Not a test-only package, despite what it's for: internal/testsupport
// needs these names and schemas for the Go suite, and cmd/testrelay needs
// the same ones to serve a real relay over HTTP. A second definition of
// either is a way for tests to pass against a table shape the relay
// doesn't actually have.
package localstack

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	awsdynamodb "github.com/aws/aws-sdk-go-v2/service/dynamodb"
	ddbtypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	awss3 "github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
)

// Endpoint is where LocalStack listens, both locally and as a CI service
// container — see .github/workflows/server-unit-test.yml.
const Endpoint = "http://localhost:4566"

// The resources. Prefixed "test-" because nothing but a local stack ever
// holds them.
const (
	LogTable       = "test-sync-log"
	BlobBucket     = "test-circle-blobs"
	SessionsTable  = "test-sessions"
	AccountsTable  = "test-accounts"
	InviteTable    = "test-invites"
	RateLimitTable = "test-rate-limit"
	PushTable      = "test-push"
)

// Config points the SDK at LocalStack with throwaway credentials.
//
// BaseEndpoint is set on the config rather than per client, so every
// client built from it lands on LocalStack without the constructor having
// to know — which is what lets cmd/testrelay hand this straight to
// app.NewWithAWS and get the real wiring rather than a copy of it.
func Config(ctx context.Context) (aws.Config, error) {
	cfg, err := awsconfig.LoadDefaultConfig(ctx,
		awsconfig.WithRegion("us-east-1"),
		awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider("test", "test", "")),
	)
	if err != nil {
		return aws.Config{}, fmt.Errorf("load AWS config: %w", err)
	}
	cfg.BaseEndpoint = aws.String(Endpoint)
	return cfg, nil
}

// sortedTables need a range key as well as a hash key; the rest are keyed
// by "pk" alone.
var sortedTables = map[string]bool{
	LogTable:    true,
	InviteTable: true,
	PushTable:   true,
}

// Provision creates every table and the bucket. Idempotent, so a second
// run — another test package, another CI step, a restarted testrelay — is
// a no-op rather than a failure.
func Provision(ctx context.Context, ddb *awsdynamodb.Client, s3 *awss3.Client) error {
	for _, table := range []string{LogTable, SessionsTable, AccountsTable, InviteTable, RateLimitTable, PushTable} {
		if err := CreateTable(ctx, ddb, table); err != nil {
			return fmt.Errorf("create %s: %w", table, err)
		}
	}
	if err := CreateBucket(ctx, s3); err != nil {
		return fmt.Errorf("create %s: %w", BlobBucket, err)
	}
	return nil
}

// CreateTable creates one of the tables above, waiting for it to become
// active. An already-existing table is success — see Provision.
func CreateTable(ctx context.Context, client *awsdynamodb.Client, name string) error {
	keys := []ddbtypes.KeySchemaElement{{AttributeName: aws.String("pk"), KeyType: ddbtypes.KeyTypeHash}}
	attrs := []ddbtypes.AttributeDefinition{{AttributeName: aws.String("pk"), AttributeType: ddbtypes.ScalarAttributeTypeS}}
	if sortedTables[name] {
		keys = append(keys, ddbtypes.KeySchemaElement{AttributeName: aws.String("sk"), KeyType: ddbtypes.KeyTypeRange})
		attrs = append(attrs, ddbtypes.AttributeDefinition{AttributeName: aws.String("sk"), AttributeType: ddbtypes.ScalarAttributeTypeS})
	}

	_, err := client.CreateTable(ctx, &awsdynamodb.CreateTableInput{
		TableName:            aws.String(name),
		BillingMode:          ddbtypes.BillingModePayPerRequest,
		KeySchema:            keys,
		AttributeDefinitions: attrs,
	})
	if err != nil {
		var inUse *ddbtypes.ResourceInUseException
		if errors.As(err, &inUse) {
			return nil
		}
		return err
	}

	waiter := awsdynamodb.NewTableExistsWaiter(client)
	return waiter.Wait(ctx, &awsdynamodb.DescribeTableInput{TableName: aws.String(name)}, 30*time.Second)
}

// CreateBucket creates the blob bucket. An already-owned bucket is
// success — see Provision.
func CreateBucket(ctx context.Context, client *awss3.Client) error {
	_, err := client.CreateBucket(ctx, &awss3.CreateBucketInput{Bucket: aws.String(BlobBucket)})
	if err != nil {
		var owned *s3types.BucketAlreadyOwnedByYou
		if errors.As(err, &owned) {
			return nil
		}
		return err
	}
	return nil
}
