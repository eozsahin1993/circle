package dynamodb_test

import (
	"context"
	"fmt"
	"strconv"
	"sync"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsdynamodb "github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"circle-relay/internal/storage/logstore"
	"circle-relay/internal/testsupport"
)

// Sort-key formats duplicated from log_store.go (unexported, and this is an
// external _test package) — epoch#<12-digit zero-padded> and idem#<id>.
// Only the two things these tests need to reach directly: reading a raw
// item's expiresAt, and deleting an item to simulate what DynamoDB's
// background TTL sweep would eventually do for real (sweep timing itself
// isn't something a fast unit test can exercise).
func epochSortKey(epoch int64) string {
	return fmt.Sprintf("epoch#%012d", epoch)
}

func idemSortKey(entryID string) string {
	return "idem#" + entryID
}

func getRawItem(t *testing.T, client *awsdynamodb.Client, table, pk, sk string) map[string]types.AttributeValue {
	t.Helper()
	out, err := client.GetItem(context.Background(), &awsdynamodb.GetItemInput{
		TableName: aws.String(table),
		Key: map[string]types.AttributeValue{
			"pk": &types.AttributeValueMemberS{Value: pk},
			"sk": &types.AttributeValueMemberS{Value: sk},
		},
	})
	if err != nil {
		t.Fatalf("failed to read raw item: %v", err)
	}
	if out.Item == nil {
		t.Fatalf("expected item at pk=%s sk=%s to exist", pk, sk)
	}
	return out.Item
}

func deleteRawItem(t *testing.T, client *awsdynamodb.Client, table, pk, sk string) {
	t.Helper()
	_, err := client.DeleteItem(context.Background(), &awsdynamodb.DeleteItemInput{
		TableName: aws.String(table),
		Key: map[string]types.AttributeValue{
			"pk": &types.AttributeValueMemberS{Value: pk},
			"sk": &types.AttributeValueMemberS{Value: sk},
		},
	})
	if err != nil {
		t.Fatalf("failed to delete raw item (simulating TTL sweep): %v", err)
	}
}

func TestLogStore_CommitEntry_ConcurrentDuplicatesConvergeToSameEpoch(t *testing.T) {
	ctx := context.Background()
	circleLogID := testsupport.UniqueCircleID(t)
	logStore := testsupport.NewLogStore(t, 0)

	const concurrency = 10
	results := make([]logstore.CommitResult, concurrency)
	errs := make([]error, concurrency)

	var wg sync.WaitGroup
	wg.Add(concurrency)
	for i := range concurrency {
		go func() {
			defer wg.Done()
			results[i], errs[i] = logStore.CommitEntry(ctx, circleLogID, "post-1", []byte("ciphertext"))
		}()
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("commit %d failed: %v", i, err)
		}
	}

	want := results[0]
	for i, got := range results {
		if got != want {
			t.Fatalf("commit %d = %+v, want %+v (all concurrent commits of the same entryID must converge)", i, got, want)
		}
	}
}

func TestLogStore_CommitEntry_WritesExpiresAtFromRetentionWindow(t *testing.T) {
	ctx := context.Background()
	circleLogID := testsupport.UniqueCircleID(t)
	const retentionDays = 7
	logStore := testsupport.NewLogStore(t, retentionDays)
	client, table := testsupport.RawDynamoDBClient(t)

	commit, err := logStore.CommitEntry(ctx, circleLogID, "post-1", []byte("ciphertext"))
	if err != nil {
		t.Fatal(err)
	}
	wantExpiresAt := commit.ReceivedAt/1000 + retentionDays*24*60*60

	entryItem := getRawItem(t, client, table, circleLogID, epochSortKey(commit.Epoch))
	if got := mustAttrInt(t, entryItem, "expiresAt"); got != wantExpiresAt {
		t.Fatalf("log entry expiresAt = %d, want %d", got, wantExpiresAt)
	}

	idemItem := getRawItem(t, client, table, circleLogID, idemSortKey("post-1"))
	if got := mustAttrInt(t, idemItem, "expiresAt"); got != wantExpiresAt {
		t.Fatalf("idempotency marker expiresAt = %d, want %d", got, wantExpiresAt)
	}
}

// DynamoDB's TTL sweep isn't something a fast unit test can wait on for
// real (AWS documents it as best-effort, not instant) — this simulates
// the outcome of a sweep having already run (deleting the item directly)
// and asserts Read()/CommitEntry() react correctly to what's actually
// left in the table, the same way they would after a real sweep.
func TestLogStore_Read_OldestAvailableEpochReflectsWhatSurvivedEviction(t *testing.T) {
	ctx := context.Background()
	circleLogID := testsupport.UniqueCircleID(t)
	logStore := testsupport.NewLogStore(t, 0)
	client, table := testsupport.RawDynamoDBClient(t)

	const numEntries = 5
	var epochs []int64
	for i := range numEntries {
		commit, err := logStore.CommitEntry(ctx, circleLogID, fmt.Sprintf("post-%d", i), []byte("ciphertext"))
		if err != nil {
			t.Fatal(err)
		}
		epochs = append(epochs, commit.Epoch)
	}

	// Simulate TTL having already evicted the two oldest entries.
	for _, epoch := range epochs[:2] {
		deleteRawItem(t, client, table, circleLogID, epochSortKey(epoch))
	}

	result, err := logStore.Read(ctx, circleLogID, 0)
	if err != nil {
		t.Fatal(err)
	}

	wantOldest := epochs[2]
	if result.OldestAvailableEpoch != wantOldest {
		t.Fatalf("expected oldestAvailableEpoch %d, got %d", wantOldest, result.OldestAvailableEpoch)
	}
	if len(result.Entries) != numEntries-2 || result.Entries[0].Epoch != wantOldest {
		t.Fatalf("expected surviving entries to start at epoch %d, got %v", wantOldest, result.Entries)
	}
}

func TestLogStore_CommitEntry_RetryAfterIdempotencyMarkerEvictionGetsNewEpoch(t *testing.T) {
	ctx := context.Background()
	circleLogID := testsupport.UniqueCircleID(t)
	logStore := testsupport.NewLogStore(t, 0)
	client, table := testsupport.RawDynamoDBClient(t)

	original, err := logStore.CommitEntry(ctx, circleLogID, "post-1", []byte("ciphertext"))
	if err != nil {
		t.Fatal(err)
	}

	// A still-present idempotency marker makes a retry converge, same as
	// before TTL existed.
	retry, err := logStore.CommitEntry(ctx, circleLogID, "post-1", []byte("ciphertext"))
	if err != nil {
		t.Fatal(err)
	}
	if retry != original {
		t.Fatalf("expected retry to converge to original commit %+v, got %+v", original, retry)
	}

	// Simulate TTL having evicted just the idempotency marker (its own
	// independent expiresAt, unrelated to the log entry's) — a retry now
	// has nothing to converge to, so it's treated as a brand-new commit.
	deleteRawItem(t, client, table, circleLogID, idemSortKey("post-1"))

	afterEviction, err := logStore.CommitEntry(ctx, circleLogID, "post-1", []byte("ciphertext"))
	if err != nil {
		t.Fatal(err)
	}
	if afterEviction.Epoch == original.Epoch {
		t.Fatalf("expected retry after idempotency marker eviction to get a new epoch, still got original epoch %d", original.Epoch)
	}
}

// readPageSize duplicated from log_store.go (unexported, and this is an
// external _test package, same reasoning as the sort-key formats above) —
// see its own doc comment for why it's an internal server policy, not a
// caller-supplied parameter.
const readPageSize = 200

// Proves Read() actually loops past DynamoDB's own internal per-call
// response cap instead of silently returning a truncated result — the bug
// this pagination fix addresses. Committing more entries than a single
// unpaginated Query could easily return isn't simulate-able the way TTL
// eviction is above; this exercises the real boundary directly.
func TestLogStore_Read_PaginatesPastASinglePageAndResumesCorrectly(t *testing.T) {
	ctx := context.Background()
	circleLogID := testsupport.UniqueCircleID(t)
	logStore := testsupport.NewLogStore(t, 0)

	const totalEntries = readPageSize + 50
	for i := range totalEntries {
		if _, err := logStore.CommitEntry(ctx, circleLogID, fmt.Sprintf("post-%d", i), []byte("ciphertext")); err != nil {
			t.Fatalf("commit %d failed: %v", i, err)
		}
	}

	first, err := logStore.Read(ctx, circleLogID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Entries) != readPageSize {
		t.Fatalf("expected exactly %d entries in a capped page, got %d", readPageSize, len(first.Entries))
	}
	if first.LatestEpoch != int64(totalEntries) {
		t.Fatalf("expected LatestEpoch to report the true latest (%d) even though this page was truncated, got %d", totalEntries, first.LatestEpoch)
	}
	lastInFirstPage := first.Entries[len(first.Entries)-1].Epoch
	if lastInFirstPage != readPageSize {
		t.Fatalf("expected the first page's last entry to be epoch %d, got %d", readPageSize, lastInFirstPage)
	}

	// A correct caller advances `since` to the last entry it actually
	// received, not to LatestEpoch — this is exactly that resumption.
	second, err := logStore.Read(ctx, circleLogID, lastInFirstPage)
	if err != nil {
		t.Fatal(err)
	}
	wantRemaining := totalEntries - readPageSize
	if len(second.Entries) != wantRemaining {
		t.Fatalf("expected the remaining %d entries on the second page, got %d", wantRemaining, len(second.Entries))
	}
	if second.Entries[0].Epoch != readPageSize+1 {
		t.Fatalf("expected the second page to pick up right after the first left off, got first epoch %d", second.Entries[0].Epoch)
	}
	if second.Entries[len(second.Entries)-1].Epoch != int64(totalEntries) {
		t.Fatalf("expected the second page to reach the true latest epoch %d, got %d", totalEntries, second.Entries[len(second.Entries)-1].Epoch)
	}
}

func mustAttrInt(t *testing.T, item map[string]types.AttributeValue, key string) int64 {
	t.Helper()
	attr, ok := item[key]
	if !ok {
		t.Fatalf("missing attribute %q", key)
	}
	n, ok := attr.(*types.AttributeValueMemberN)
	if !ok {
		t.Fatalf("attribute %q is not a number", key)
	}
	value, err := strconv.ParseInt(n.Value, 10, 64)
	if err != nil {
		t.Fatalf("attribute %q is not a valid integer: %v", key, err)
	}
	return value
}
