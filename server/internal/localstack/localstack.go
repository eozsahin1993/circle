// Package localstack names the AWS resources a local LocalStack instance
// holds, and creates them — shared by internal/testsupport and
// cmd/testrelay so neither can drift onto a table shape the other isn't
// actually using.
package localstack

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	awsdynamodb "github.com/aws/aws-sdk-go-v2/service/dynamodb"
	ddbtypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	awss3 "github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"

	"circle-relay/internal/config"
)

// DefaultEndpoint is where LocalStack listens locally and in CI.
// EndpointEnv overrides it — including to a dead port, which is how
// Required's fail-rather-than-skip path gets tested without stopping a
// real container.
const (
	DefaultEndpoint = "http://localhost:4566"
	EndpointEnv     = "LOCALSTACK_ENDPOINT"
)

// Endpoint is where to find LocalStack. A function rather than a constant
// so every client in the module resolves it the same way — testsupport
// used to hold its own copy, which meant an override reached the
// integration suite and not the rest.
func Endpoint() string {
	if override := os.Getenv(EndpointEnv); override != "" {
		return override
	}
	return DefaultEndpoint
}

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

// RequireEnv, when set, makes an unreachable LocalStack a failure instead
// of a skip.
const RequireEnv = "REQUIRE_LOCALSTACK"

// Required reports whether a missing LocalStack should fail rather than
// skip — set by CI, where a dead container should turn the run red
// instead of quietly skipping almost everything.
func Required() bool {
	return os.Getenv(RequireEnv) != ""
}

// Config points the SDK at LocalStack with throwaway credentials.
// BaseEndpoint lives on the config, not per client, so app.Deps can be
// handed this config and build ordinary clients with no LocalStack
// knowledge of its own.
func Config(ctx context.Context) (aws.Config, error) {
	cfg, err := awsconfig.LoadDefaultConfig(ctx,
		awsconfig.WithRegion("us-east-1"),
		awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider("test", "test", "")),
	)
	if err != nil {
		return aws.Config{}, fmt.Errorf("load AWS config: %w", err)
	}
	cfg.BaseEndpoint = aws.String(Endpoint())
	return cfg, nil
}

// RelayConfig is config.Load's shape for a relay served against
// LocalStack, with test values baked in rather than read from the
// environment. Rate limits stay at their production defaults on
// purpose — unlike the Go suite, which pins them to a million to stay out
// of its own way, so this is the only place the real budgets and the
// router run together.
func RelayConfig(names Names) config.Config {
	return config.Config{
		TableName:                 names.LogTable,
		BucketName:                names.BlobBucket,
		SessionsTableName:         names.SessionsTable,
		AccountsTableName:         names.AccountsTable,
		InviteTableName:           names.InviteTable,
		RateLimitTableName:        names.RateLimitTable,
		PushTableName:             names.PushTable,
		RateLimitWriteMaxRequests: 500,
		RateLimitReadMaxRequests:  2000,
		RateLimitPushMaxRequests:  500,
		RateLimitWindowMinutes:    10,
		// LocalStack doesn't resolve virtual-hosted-style bucket
		// subdomains, so presigned URLs have to be path style.
		S3ForcePathStyle: true,
	}
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

// TeardownSet removes a set. Best effort — an already-gone resource isn't
// an error — and empties the bucket first, since S3 refuses to delete one
// that still holds objects.
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
		if !errors.As(err, &inUse) {
			return err
		}
		// Already exists, created by a concurrent test binary racing this
		// same shared table — but "exists" isn't "active": fall through
		// to the waiter rather than return early, so a caller here right
		// after doesn't hit the table mid-CREATING.
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
