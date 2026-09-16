package dynamodb_test

import (
	"context"
	"errors"
	"testing"

	"mimoza-relay/internal/account"
	"mimoza-relay/internal/util/testsupport"
)

func TestManifestStore_PutManifestThenGetManifest_RoundTrips(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewManifestStore(t)
	accountID := testsupport.UniqueAccountID(t)
	blob := []byte("pretend-ciphertext")

	if err := store.PutManifest(ctx, accountID, blob, 0); err != nil {
		t.Fatal(err)
	}

	got, err := store.GetManifest(ctx, accountID)
	if err != nil {
		t.Fatal(err)
	}
	if string(got.Blob) != string(blob) {
		t.Fatalf("expected %q, got %q", blob, got.Blob)
	}
	if got.Version != 1 {
		t.Fatalf("expected a first write to land at version 1, got %d", got.Version)
	}
}

func TestManifestStore_GetManifest_ReturnsNilForAnUnknownAccount(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewManifestStore(t)

	got, err := store.GetManifest(ctx, testsupport.UniqueAccountID(t))
	if err != nil {
		t.Fatal(err)
	}
	if got.Blob != nil {
		t.Fatalf("expected nil for an unknown account, got %q", got.Blob)
	}
	if got.Version != 0 {
		t.Fatalf("expected version 0 for an unknown account, got %d", got.Version)
	}
}

func TestManifestStore_PutManifest_OverwritesWhenTheVersionStillMatches(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewManifestStore(t)
	accountID := testsupport.UniqueAccountID(t)

	if err := store.PutManifest(ctx, accountID, []byte("first"), 0); err != nil {
		t.Fatal(err)
	}
	if err := store.PutManifest(ctx, accountID, []byte("second"), 1); err != nil {
		t.Fatal(err)
	}

	got, err := store.GetManifest(ctx, accountID)
	if err != nil {
		t.Fatal(err)
	}
	if string(got.Blob) != "second" {
		t.Fatalf("expected the second write to win, got %q", got.Blob)
	}
	if got.Version != 2 {
		t.Fatalf("expected the version to advance to 2, got %d", got.Version)
	}
}

// Two of the same account's devices writing at once. The loser has to find
// out, because the blob carries circle content keys — a silently dropped
// write costs access to whatever circle the winner had just recorded.
func TestManifestStore_PutManifest_RejectsAStaleVersion(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewManifestStore(t)
	accountID := testsupport.UniqueAccountID(t)

	if err := store.PutManifest(ctx, accountID, []byte("first"), 0); err != nil {
		t.Fatal(err)
	}

	err := store.PutManifest(ctx, accountID, []byte("racing"), 0)
	if !errors.Is(err, account.ErrVersionMismatch) {
		t.Fatalf("expected ErrVersionMismatch, got %v", err)
	}

	got, err := store.GetManifest(ctx, accountID)
	if err != nil {
		t.Fatal(err)
	}
	if string(got.Blob) != "first" {
		t.Fatalf("expected the losing write to leave the stored blob alone, got %q", got.Blob)
	}
}
