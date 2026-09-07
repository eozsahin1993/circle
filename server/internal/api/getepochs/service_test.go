package getepochs_test

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"testing"

	"circle-relay/internal/api/getepochs"
	"circle-relay/internal/storage/logstore"
	"circle-relay/internal/testsupport"
)

// newToken/hashToken duplicate getlog_test's own helpers — same reasoning:
// this package only needs a token whose hash it knows, to bootstrap a
// circle it can then write entries into before peeking at its epochs.
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
	raw, err := hex.DecodeString(tokenHex)
	if err != nil {
		t.Fatalf("test token isn't valid hex: %v", err)
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func TestService_Peek_DelegatesToLogStoreAcrossSeveralCircles(t *testing.T) {
	ctx := context.Background()
	logStore := testsupport.NewLogStore(t)
	placeholderAuthorityKey := hex.EncodeToString(make([]byte, 32))

	syncIDA := testsupport.UniqueSyncID(t)
	tokenA := newToken(t)
	if err := logStore.Bootstrap(ctx, syncIDA, placeholderAuthorityKey, hashToken(t, tokenA)); err != nil {
		t.Fatal(err)
	}
	if _, err := logStore.Append(ctx, syncIDA, logstore.NamespaceContent, "post-1", []byte("c"), 1, tokenA); err != nil {
		t.Fatal(err)
	}

	syncIDB := testsupport.UniqueSyncID(t)

	service := &getepochs.Service{LogStore: logStore}
	result, err := service.Peek(ctx, []string{syncIDA, syncIDB})
	if err != nil {
		t.Fatal(err)
	}

	if got := result[syncIDA]; got.Content != 1 {
		t.Fatalf("expected circle A's content epoch to be 1, got %d", got.Content)
	}
	if _, ok := result[syncIDB]; ok {
		t.Fatal("expected the never-bootstrapped circle B to be omitted from the result")
	}
}
