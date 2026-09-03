package getuploadtarget_test

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"testing"

	"circle-relay/internal/api/getuploadtarget"
	"circle-relay/internal/storage/logstore"
	"circle-relay/internal/testsupport"
)

func newToken(t *testing.T) string {
	t.Helper()
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(buf)
}

func hashToken(tokenHex string) string {
	raw, _ := hex.DecodeString(tokenHex)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func TestService_UploadTarget_SucceedsWithTheCurrentWriteToken(t *testing.T) {
	ctx := context.Background()
	syncID := testsupport.UniqueSyncID(t)
	token := newToken(t)
	logStore := testsupport.NewLogStore(t)
	if err := logStore.Bootstrap(ctx, syncID, hex.EncodeToString(make([]byte, 32)), hashToken(token)); err != nil {
		t.Fatal(err)
	}

	service := &getuploadtarget.Service{BlobStore: testsupport.NewBlobStore(t), LogStore: logStore}

	target, err := service.UploadTarget(ctx, syncID, "entry-1", token)
	if err != nil {
		t.Fatal(err)
	}
	if target.URL == "" {
		t.Fatal("expected a non-empty upload URL")
	}
	if target.Fields["key"] != syncID+"/entry-1" {
		t.Fatalf("expected upload fields' key to be %s/entry-1, got %q", syncID, target.Fields["key"])
	}
}

func TestService_UploadTarget_RejectsWrongWriteToken(t *testing.T) {
	ctx := context.Background()
	syncID := testsupport.UniqueSyncID(t)
	logStore := testsupport.NewLogStore(t)
	if err := logStore.Bootstrap(ctx, syncID, hex.EncodeToString(make([]byte, 32)), hashToken(newToken(t))); err != nil {
		t.Fatal(err)
	}

	service := &getuploadtarget.Service{BlobStore: testsupport.NewBlobStore(t), LogStore: logStore}

	_, err := service.UploadTarget(ctx, syncID, "entry-1", newToken(t))
	if !errors.Is(err, logstore.ErrWriteTokenMismatch) {
		t.Fatalf("expected ErrWriteTokenMismatch, got %v", err)
	}
}
