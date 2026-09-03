package getlog_test

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"testing"

	"circle-relay/internal/api/getlog"
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
// circle it can then write an entry into before reading it back.
func hashToken(t *testing.T, tokenHex string) string {
	t.Helper()
	raw, err := hex.DecodeString(tokenHex)
	if err != nil {
		t.Fatalf("test token isn't valid hex: %v", err)
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
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

	commit, err := logStore.Append(ctx, syncID, logstore.NamespaceContent, "post-1", []byte("ciphertext"), 1, token)
	if err != nil {
		t.Fatal(err)
	}

	service := &getlog.Service{LogStore: logStore}
	result, err := service.Fetch(ctx, syncID, logstore.NamespaceContent, 0)
	if err != nil {
		t.Fatal(err)
	}

	if len(result.Entries) != 1 || result.Entries[0].Epoch != commit.Epoch {
		t.Fatalf("expected one entry at epoch %d, got %v", commit.Epoch, result.Entries)
	}

	// The other namespace must stay empty — nothing was ever written to it.
	metaResult, err := service.Fetch(ctx, syncID, logstore.NamespaceMeta, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(metaResult.Entries) != 0 {
		t.Fatalf("expected meta namespace to be empty, got %v", metaResult.Entries)
	}
}
