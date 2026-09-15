package manifest_test

import (
	"context"
	"errors"
	"testing"

	"circle-relay/internal/account"
	"circle-relay/internal/account/http/manifest"
	"circle-relay/internal/testsupport"
)

func TestService_PutThenGet_RoundTrips(t *testing.T) {
	ctx := context.Background()
	svc := &manifest.Service{ManifestStore: testsupport.NewManifestStore(t)}
	accountID := testsupport.UniqueAccountID(t)
	blob := []byte("pretend-ciphertext")

	if err := svc.Put(ctx, accountID, blob, 0); err != nil {
		t.Fatal(err)
	}

	got, err := svc.Get(ctx, accountID)
	if err != nil {
		t.Fatal(err)
	}
	if string(got.Blob) != string(blob) {
		t.Fatalf("expected %q, got %q", blob, got.Blob)
	}
}

func TestService_Get_ReturnsNilForAnAccountThatNeverStoredAManifest(t *testing.T) {
	ctx := context.Background()
	svc := &manifest.Service{ManifestStore: testsupport.NewManifestStore(t)}

	got, err := svc.Get(ctx, testsupport.UniqueAccountID(t))
	if err != nil {
		t.Fatal(err)
	}
	if got.Blob != nil {
		t.Fatalf("expected nil, got %q", got.Blob)
	}
}

func TestService_Put_SurfacesAVersionMismatch(t *testing.T) {
	ctx := context.Background()
	svc := &manifest.Service{ManifestStore: testsupport.NewManifestStore(t)}
	accountID := testsupport.UniqueAccountID(t)

	if err := svc.Put(ctx, accountID, []byte("first"), 0); err != nil {
		t.Fatal(err)
	}

	err := svc.Put(ctx, accountID, []byte("racing"), 0)
	if !errors.Is(err, account.ErrVersionMismatch) {
		t.Fatalf("expected ErrVersionMismatch, got %v", err)
	}
}
