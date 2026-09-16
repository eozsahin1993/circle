package appendlog_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"testing"

	"circle-relay/internal/synclog"
	"circle-relay/internal/synclog/http/appendlog"
	"circle-relay/internal/util/testsupport"
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

func hashToken(t *testing.T, tokenHex string) string {
	t.Helper()
	hash, err := synclog.WriteTokenHash(tokenHex)
	if err != nil {
		t.Fatalf("test token isn't valid hex: %v", err)
	}
	return hash
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
	return &appendlog.Service{Log: &synclog.Service{Log: logStore}}, syncID, token
}

func TestService_Append_SucceedsAfterBootstrapAndAssignsEpoch(t *testing.T) {
	service, syncID, token := newService(t)

	result, err := service.Append(context.Background(), syncID, synclog.NamespaceContent, "post-1", []byte("ciphertext"), 1, token, "test-author-key")
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

	first, err := service.Append(ctx, syncID, synclog.NamespaceContent, "post-1", []byte("ciphertext"), 1, token, "test-author-key")
	if err != nil {
		t.Fatal(err)
	}
	retry, err := service.Append(ctx, syncID, synclog.NamespaceContent, "post-1", []byte("ciphertext"), 1, token, "test-author-key")
	if err != nil {
		t.Fatal(err)
	}

	if retry.Epoch != first.Epoch || retry.ReceivedAt != first.ReceivedAt {
		t.Fatalf("expected retry to return original result %+v, got %+v", first, retry)
	}
}
