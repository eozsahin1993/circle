package fetchentries_test

import (
	"context"
	"testing"

	"circle-relay/internal/api/fetchentries"
	"circle-relay/internal/testsupport"
)

func TestService_Fetch_DelegatesToLogStore(t *testing.T) {
	ctx := context.Background()
	circleLogID := testsupport.UniqueCircleID(t)
	logStore := testsupport.NewLogStore(t, 0)

	commit, err := logStore.CommitEntry(ctx, circleLogID, "post-1", []byte("ciphertext"))
	if err != nil {
		t.Fatal(err)
	}

	service := &fetchentries.Service{LogStore: logStore}
	result, err := service.Fetch(ctx, circleLogID, 0)
	if err != nil {
		t.Fatal(err)
	}

	if len(result.Entries) != 1 || result.Entries[0].Epoch != commit.Epoch {
		t.Fatalf("expected one entry at epoch %d, got %v", commit.Epoch, result.Entries)
	}
}
