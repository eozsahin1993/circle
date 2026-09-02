package manifest_test

import (
	"context"
	"testing"

	"circle-relay/internal/api/account/manifest"
	"circle-relay/internal/testsupport"
)

func TestService_PutThenGet_RoundTrips(t *testing.T) {
	ctx := context.Background()
	svc := &manifest.Service{ManifestStore: testsupport.NewManifestStore(t)}
	accountID := testsupport.UniqueAccountID(t)
	blob := []byte("pretend-ciphertext")

	if err := svc.Put(ctx, accountID, blob); err != nil {
		t.Fatal(err)
	}

	got, err := svc.Get(ctx, accountID)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(blob) {
		t.Fatalf("expected %q, got %q", blob, got)
	}
}

func TestService_Get_ReturnsNilForAnAccountThatNeverStoredAManifest(t *testing.T) {
	ctx := context.Background()
	svc := &manifest.Service{ManifestStore: testsupport.NewManifestStore(t)}

	got, err := svc.Get(ctx, testsupport.UniqueAccountID(t))
	if err != nil {
		t.Fatal(err)
	}
	if got != nil {
		t.Fatalf("expected nil, got %q", got)
	}
}
