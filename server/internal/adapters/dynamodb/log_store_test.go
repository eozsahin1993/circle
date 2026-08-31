package dynamodb_test

import (
	"context"
	"fmt"
	"sync"
	"testing"

	"circle-relay/internal/ports"
	"circle-relay/internal/testsupport"
)

func TestLogStore_CommitEntry_ConcurrentDuplicatesConvergeToSameEpoch(t *testing.T) {
	ctx := context.Background()
	circleLogID := testsupport.UniqueCircleID(t)
	logStore := testsupport.NewLogStore(t, 0)

	const concurrency = 10
	results := make([]ports.CommitResult, concurrency)
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

func TestLogStore_Trim_DeletesEntriesBeyondRingBufferSize(t *testing.T) {
	ctx := context.Background()
	circleLogID := testsupport.UniqueCircleID(t)
	const ringBufferSize = 3
	logStore := testsupport.NewLogStore(t, ringBufferSize)

	var epochs []int64
	for i := range 5 {
		commit, err := logStore.CommitEntry(ctx, circleLogID, fmt.Sprintf("post-%d", i), []byte("ciphertext"))
		if err != nil {
			t.Fatal(err)
		}
		epochs = append(epochs, commit.Epoch)
	}

	if err := logStore.Trim(ctx, circleLogID); err != nil {
		t.Fatal(err)
	}

	result, err := logStore.Read(ctx, circleLogID, 0)
	if err != nil {
		t.Fatal(err)
	}

	if len(result.Entries) != ringBufferSize {
		t.Fatalf("expected %d entries to remain after trim, got %d", ringBufferSize, len(result.Entries))
	}

	wantOldest := epochs[len(epochs)-ringBufferSize]
	if result.OldestAvailableEpoch != wantOldest {
		t.Fatalf("expected oldestAvailableEpoch %d, got %d", wantOldest, result.OldestAvailableEpoch)
	}
	if result.Entries[0].Epoch != wantOldest {
		t.Fatalf("expected surviving entries to start at epoch %d, got %d", wantOldest, result.Entries[0].Epoch)
	}
}
