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

// The shared resources — see Shared.
const (
	LogTable       = "test-sync-log"
	BlobBucket     = "test-circle-blobs"
	SessionsTable  = "test-sessions"
	AccountsTable  = "test-accounts"
	InviteTable    = "test-invites"
	RateLimitTable = "test-rate-limit"
	PushTable      = "test-push"
)

// Names is one complete, independent set of resources — everything a
// relay needs to run and nothing shared with another set.
type Names struct {
	LogTable       string
	SessionsTable  string
	AccountsTable  string
	InviteTable    string
	RateLimitTable string
	PushTable      string
	BlobBucket     string
}

// Shared is the fixed set. internal/testsupport uses it for the whole Go
// suite at once, which is safe because those tests pick distinct syncIDs
// and every table is partitioned by one.
func Shared() Names {
	return Names{
		LogTable:       LogTable,
		SessionsTable:  SessionsTable,
		AccountsTable:  AccountsTable,
		InviteTable:    InviteTable,
		RateLimitTable: RateLimitTable,
		PushTable:      PushTable,
		BlobBucket:     BlobBucket,
	}
}

// Unique is a set nothing else will touch, for a test that wants an empty
// relay rather than a corner of a shared one — so it can assert on totals
// ("the log holds exactly these entries") instead of filtering to its own
// ids, and so a leak between tests is impossible rather than unlikely.
// Creating one costs about 200ms.
func Unique(suffix string) Names {
	return Names{
		LogTable:       "bb-log-" + suffix,
		SessionsTable:  "bb-sessions-" + suffix,
		AccountsTable:  "bb-accounts-" + suffix,
		InviteTable:    "bb-invites-" + suffix,
		RateLimitTable: "bb-rate-limit-" + suffix,
		PushTable:      "bb-push-" + suffix,
		// S3 is stricter than DynamoDB about names: lowercase, no
		// underscores, 3-63 characters.
		BlobBucket: "bb-blobs-" + suffix,
	}
}

// Config points the SDK at LocalStack with throwaway credentials.
//
// BaseEndpoint is set on the config rather than per client, so every
// client built from it lands on LocalStack without the constructor having
// to know — which is what lets app.Deps be handed a LocalStack config and
// need no knowledge of it.
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

// Sorted is whether a table needs a range key as well as a hash key. By
// role rather than by name, since Unique renames everything.
type Sorted bool

const (
	HashOnly    Sorted = false
	WithSortKey Sorted = true
)

// sorted pairs each table in a set with the schema its adapter expects.
func (n Names) sorted() []struct {
	name   string
	sorted Sorted
} {
	return []struct {
		name   string
		sorted Sorted
	}{
		{n.LogTable, WithSortKey},
		{n.InviteTable, WithSortKey},
		{n.PushTable, WithSortKey},
		{n.SessionsTable, HashOnly},
		{n.AccountsTable, HashOnly},
		{n.RateLimitTable, HashOnly},
	}
}

// Provision creates the shared set — see Shared.
func Provision(ctx context.Context, ddb *awsdynamodb.Client, s3 *awss3.Client) error {
	return ProvisionSet(ctx, ddb, s3, Shared())
}

// ProvisionSet creates every table and the bucket in one set. Idempotent,
// so a second run — another test package, another CI step, a restarted
// testrelay — is a no-op rather than a failure.
func ProvisionSet(ctx context.Context, ddb *awsdynamodb.Client, s3 *awss3.Client, names Names) error {
	for _, table := range names.sorted() {
		if err := CreateTable(ctx, ddb, table.name, table.sorted); err != nil {
			return fmt.Errorf("create %s: %w", table.name, err)
		}
	}
	if err := CreateBucket(ctx, s3, names.BlobBucket); err != nil {
		return fmt.Errorf("create %s: %w", names.BlobBucket, err)
	}
	return nil
}

// TeardownSet removes a set, so a run of unique sets doesn't leave
// LocalStack carrying every table any test has ever asked for. Best
// effort: a resource already gone, or never created because provisioning
// failed partway, isn't an error.
//
// The bucket's objects go first — S3 refuses to delete a bucket that
// still holds any.
func TeardownSet(ctx context.Context, ddb *awsdynamodb.Client, s3 *awss3.Client, names Names) {
	for _, table := range names.sorted() {
		_, _ = ddb.DeleteTable(ctx, &awsdynamodb.DeleteTableInput{TableName: aws.String(table.name)})
	}

	objects, err := s3.ListObjectsV2(ctx, &awss3.ListObjectsV2Input{Bucket: aws.String(names.BlobBucket)})
	if err == nil {
		for _, object := range objects.Contents {
			_, _ = s3.DeleteObject(ctx, &awss3.DeleteObjectInput{Bucket: aws.String(names.BlobBucket), Key: object.Key})
		}
	}
	_, _ = s3.DeleteBucket(ctx, &awss3.DeleteBucketInput{Bucket: aws.String(names.BlobBucket)})
}

// CreateTable creates one table, waiting for it to become active. An
// already-existing table is success — see ProvisionSet.
func CreateTable(ctx context.Context, client *awsdynamodb.Client, name string, sorted Sorted) error {
	keys := []ddbtypes.KeySchemaElement{{AttributeName: aws.String("pk"), KeyType: ddbtypes.KeyTypeHash}}
	attrs := []ddbtypes.AttributeDefinition{{AttributeName: aws.String("pk"), AttributeType: ddbtypes.ScalarAttributeTypeS}}
	if sorted {
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

// CreateBucket creates a blob bucket. An already-owned bucket is
// success — see ProvisionSet.
func CreateBucket(ctx context.Context, client *awss3.Client, name string) error {
	_, err := client.CreateBucket(ctx, &awss3.CreateBucketInput{Bucket: aws.String(name)})
	if err != nil {
		var owned *s3types.BucketAlreadyOwnedByYou
		if errors.As(err, &owned) {
			return nil
		}
		return err
	}
	return nil
}
