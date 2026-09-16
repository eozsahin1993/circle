package getlog_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"testing"

	"mimoza-relay/internal/synclog"
	"mimoza-relay/internal/synclog/http/getlog"
	"mimoza-relay/internal/util/testsupport"
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

func TestService_Fetch_DelegatesToLogStoreForTheRequestedNamespace(t *testing.T) {
	ctx := context.Background()
	syncID := testsupport.UniqueSyncID(t)
	token := newToken(t)
	logStore := testsupport.NewLogStore(t)
	placeholderAuthorityKey := hex.EncodeToString(make([]byte, 32))
	if err := logStore.Bootstrap(ctx, syncID, placeholderAuthorityKey, hashToken(t, token)); err != nil {
		t.Fatal(err)
	}

	commit, err := logStore.Append(ctx, syncID, synclog.NamespaceContent, "post-1", []byte("ciphertext"), 1, hashToken(t, token), "test-author-key")
	if err != nil {
		t.Fatal(err)
	}

	service := &getlog.Service{LogStore: logStore}
	result, err := service.Fetch(ctx, syncID, synclog.NamespaceContent, 0)
	if err != nil {
		t.Fatal(err)
	}

	if len(result.Entries) != 1 || result.Entries[0].Epoch != commit.Epoch {
		t.Fatalf("expected one entry at epoch %d, got %v", commit.Epoch, result.Entries)
	}

	// The other namespace must stay empty — nothing was ever written to it.
	metaResult, err := service.Fetch(ctx, syncID, synclog.NamespaceMeta, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(metaResult.Entries) != 0 {
		t.Fatalf("expected meta namespace to be empty, got %v", metaResult.Entries)
	}
}
