// Package testsupport wires the real adapters (not fakes) to a LocalStack
// instance at localhost:4566, so tests exercise actual DynamoDB/S3 wire
// behavior. Not a _test.go file — a regular package imported by other
// packages' tests, per Go convention for shared test helpers.
package testsupport

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	awsdynamodb "github.com/aws/aws-sdk-go-v2/service/dynamodb"
	ddbtypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	awss3 "github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"

	"circle-relay/internal/adapters/dynamodb"
	"circle-relay/internal/adapters/s3"
	"circle-relay/internal/ports"
)

const (
	localstackEndpoint = "http://localhost:4566"
	tableName          = "test-circle-log"
	bucketName         = "test-circle-blobs"
)

var (
	tableOnce sync.Once
	tableErr  error

	bucketOnce sync.Once
	bucketErr  error
)

// UniqueCircleID returns a circleLogID guaranteed not to collide with data
// left behind by a previous test run — the shared test table isn't wiped
// between `go test` invocations, only created once, so hardcoded IDs
// (and hardcoded epoch assertions) would go flaky on a second run.
func UniqueCircleID(t testing.TB) string {
	t.Helper()
	return fmt.Sprintf("%s-%d", t.Name(), time.Now().UnixNano())
}

func loadConfig(t testing.TB) aws.Config {
	t.Helper()
	cfg, err := awsconfig.LoadDefaultConfig(context.Background(),
		awsconfig.WithRegion("us-east-1"),
		awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider("test", "test", "")),
	)
	if err != nil {
		t.Fatalf("failed to load AWS config: %v", err)
	}
	return cfg
}

// NewLogStore returns a real dynamodb-backed LogStore against LocalStack,
// creating the test table once per test binary run (shared across tests —
// safe because tests use distinct circleLogID values). Skips the test if
// LocalStack isn't reachable.
func NewLogStore(t testing.TB, logRetentionDays int64) ports.LogStore {
	t.Helper()
	client := awsdynamodb.NewFromConfig(loadConfig(t), func(o *awsdynamodb.Options) {
		o.BaseEndpoint = aws.String(localstackEndpoint)
	})

	tableOnce.Do(func() { tableErr = createTable(client) })
	if tableErr != nil {
		t.Skipf("LocalStack DynamoDB not reachable, skipping: %v", tableErr)
	}

	return dynamodb.NewLogStore(client, tableName, logRetentionDays)
}

// RawDynamoDBClient returns the same client + table name NewLogStore uses,
// for tests that need to inspect raw item attributes (e.g. expiresAt) or
// delete an item directly to simulate what DynamoDB's background TTL
// sweep would eventually do — sweep timing itself isn't something a fast
// unit test can exercise for real.
func RawDynamoDBClient(t testing.TB) (*awsdynamodb.Client, string) {
	t.Helper()
	client := awsdynamodb.NewFromConfig(loadConfig(t), func(o *awsdynamodb.Options) {
		o.BaseEndpoint = aws.String(localstackEndpoint)
	})

	tableOnce.Do(func() { tableErr = createTable(client) })
	if tableErr != nil {
		t.Skipf("LocalStack DynamoDB not reachable, skipping: %v", tableErr)
	}

	return client, tableName
}

// NewBlobStore returns a real s3-backed BlobStore against LocalStack,
// creating the test bucket once per test binary run.
func NewBlobStore(t testing.TB) ports.BlobStore {
	t.Helper()
	client := awss3.NewFromConfig(loadConfig(t), func(o *awss3.Options) {
		o.BaseEndpoint = aws.String(localstackEndpoint)
		o.UsePathStyle = true
	})

	bucketOnce.Do(func() { bucketErr = createBucket(client) })
	if bucketErr != nil {
		t.Skipf("LocalStack S3 not reachable, skipping: %v", bucketErr)
	}

	return s3.NewBlobStore(client, bucketName, 0)
}

func createTable(client *awsdynamodb.Client) error {
	ctx := context.Background()
	_, err := client.CreateTable(ctx, &awsdynamodb.CreateTableInput{
		TableName:   aws.String(tableName),
		BillingMode: ddbtypes.BillingModePayPerRequest,
		KeySchema: []ddbtypes.KeySchemaElement{
			{AttributeName: aws.String("pk"), KeyType: ddbtypes.KeyTypeHash},
			{AttributeName: aws.String("sk"), KeyType: ddbtypes.KeyTypeRange},
		},
		AttributeDefinitions: []ddbtypes.AttributeDefinition{
			{AttributeName: aws.String("pk"), AttributeType: ddbtypes.ScalarAttributeTypeS},
			{AttributeName: aws.String("sk"), AttributeType: ddbtypes.ScalarAttributeTypeS},
		},
	})
	if err != nil {
		var inUse *ddbtypes.ResourceInUseException
		if errors.As(err, &inUse) {
			return nil // already created by an earlier test package's run
		}
		return err
	}
	waiter := awsdynamodb.NewTableExistsWaiter(client)
	return waiter.Wait(ctx, &awsdynamodb.DescribeTableInput{TableName: aws.String(tableName)}, 30*time.Second)
}

func createBucket(client *awss3.Client) error {
	_, err := client.CreateBucket(context.Background(), &awss3.CreateBucketInput{Bucket: aws.String(bucketName)})
	if err != nil {
		var owned *s3types.BucketAlreadyOwnedByYou
		if errors.As(err, &owned) {
			return nil // already created by an earlier test package's run
		}
		return err
	}
	return nil
}
