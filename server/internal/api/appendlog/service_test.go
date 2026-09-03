package appendlog_test

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"testing"

	"circle-relay/internal/api/appendlog"
	"circle-relay/internal/storage/logstore"
	"circle-relay/internal/testsupport"
)

// newToken returns a fresh, random hex-encoded string standing in for a
// real writeToken — must be valid hex, unlike testsupport.UniqueSyncID
// (which embeds the test name).
func newToken(t *testing.T) string {
	t.Helper()
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		t.Fatalf("failed to generate random token: %v", err)
	}
	return hex.EncodeToString(buf)
}

// hashToken duplicates logstore/dynamodb's own private hashWriteToken —
// this package only needs a token whose hash it knows, to bootstrap a
// circle it can then Append into.
func hashToken(t *testing.T, tokenHex string) string {
	t.Helper()
	raw, err := hex.DecodeString(tokenHex)
	if err != nil {
		t.Fatalf("test token isn't valid hex: %v", err)
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func newService(t *testing.T) (*appendlog.Service, string, string) {
	t.Helper()
	ctx := context.Background()
	syncID := testsupport.UniqueSyncID(t)
	token := newToken(t)
	logStore := testsupport.NewLogStore(t)
	// This package never calls Rotate, so the authority key's value is
	// never cryptographically checked — any placeholder string works.
	placeholderAuthorityKey := hex.EncodeToString(make([]byte, 32))
	if err := logStore.Bootstrap(ctx, syncID, placeholderAuthorityKey, hashToken(t, token)); err != nil {
		t.Fatalf("bootstrap failed: %v", err)
	}
	return &appendlog.Service{LogStore: logStore}, syncID, token
}

func TestService_Append_SucceedsAfterBootstrapAndAssignsEpoch(t *testing.T) {
	service, syncID, token := newService(t)

	result, err := service.Append(context.Background(), syncID, logstore.NamespaceContent, "post-1", []byte("ciphertext"), 1, token)
	if err != nil {
		t.Fatal(err)
	}
	if result.Epoch != 1 {
		t.Fatalf("expected the first content entry at epoch 1, got %d", result.Epoch)
	}
}

func TestService_Append_RetryingSameEntryIDConverges(t *testing.T) {
	service, syncID, token := newService(t)
	ctx := context.Background()

	first, err := service.Append(ctx, syncID, logstore.NamespaceContent, "post-1", []byte("ciphertext"), 1, token)
	if err != nil {
		t.Fatal(err)
	}
	retry, err := service.Append(ctx, syncID, logstore.NamespaceContent, "post-1", []byte("ciphertext"), 1, token)
	if err != nil {
		t.Fatal(err)
	}

	if retry.Epoch != first.Epoch || retry.ReceivedAt != first.ReceivedAt {
		t.Fatalf("expected retry to return original result %+v, got %+v", first, retry)
	}
}
