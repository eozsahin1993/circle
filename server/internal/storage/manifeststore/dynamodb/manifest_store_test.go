package dynamodb_test

import (
	"context"
	"testing"

	"circle-relay/internal/testsupport"
)

func TestManifestStore_PutManifestThenGetManifest_RoundTrips(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewManifestStore(t)
	accountID := testsupport.UniqueAccountID(t)
	blob := []byte("pretend-ciphertext")

	if err := store.PutManifest(ctx, accountID, blob); err != nil {
		t.Fatal(err)
	}

	got, err := store.GetManifest(ctx, accountID)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(blob) {
		t.Fatalf("expected %q, got %q", blob, got)
	}
}

func TestManifestStore_GetManifest_ReturnsNilForAnUnknownAccount(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewManifestStore(t)

	got, err := store.GetManifest(ctx, testsupport.UniqueAccountID(t))
	if err != nil {
		t.Fatal(err)
	}
	if got != nil {
		t.Fatalf("expected nil for an unknown account, got %q", got)
	}
}

func TestManifestStore_PutManifest_OverwritesInPlace(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewManifestStore(t)
	accountID := testsupport.UniqueAccountID(t)

	if err := store.PutManifest(ctx, accountID, []byte("first")); err != nil {
		t.Fatal(err)
	}
	if err := store.PutManifest(ctx, accountID, []byte("second")); err != nil {
		t.Fatal(err)
	}

	got, err := store.GetManifest(ctx, accountID)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "second" {
		t.Fatalf("expected the second write to win, got %q", got)
	}
}
