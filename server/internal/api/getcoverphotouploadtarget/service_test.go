package getcoverphotouploadtarget_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"testing"

	"circle-relay/internal/api/getcoverphotouploadtarget"
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

// bootstrapWithFounder bootstraps a fresh syncID and returns the write
// token plus the founder's authority keypair, so callers can sign a
// well-formed request against it.
func bootstrapWithFounder(t *testing.T) (syncID, writeToken string, founderPub ed25519.PublicKey, founderPriv ed25519.PrivateKey, logStore logstore.Store) {
	t.Helper()
	ctx := context.Background()
	syncID = testsupport.UniqueSyncID(t)
	writeToken = newToken(t)
	founderPub, founderPriv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	logStore = testsupport.NewLogStore(t)
	if err := logStore.Bootstrap(ctx, syncID, hex.EncodeToString(founderPub), hashToken(writeToken)); err != nil {
		t.Fatal(err)
	}
	return syncID, writeToken, founderPub, founderPriv, logStore
}

func TestService_UploadTarget_SucceedsForTheFounderAuthority(t *testing.T) {
	syncID, writeToken, founderPub, founderPriv, logStore := bootstrapWithFounder(t)
	signature := ed25519.Sign(founderPriv, logstore.CoverPhotoUploadMessage(syncID))

	service := &getcoverphotouploadtarget.Service{BlobStore: testsupport.NewBlobStore(t), LogStore: logStore}
	target, err := service.UploadTarget(context.Background(), syncID, writeToken, hex.EncodeToString(founderPub), signature)
	if err != nil {
		t.Fatal(err)
	}
	if target.URL == "" {
		t.Fatal("expected a non-empty upload URL")
	}
	if target.Fields["key"] != syncID+"/cover" {
		t.Fatalf("expected upload fields' key to be %s/cover, got %q", syncID, target.Fields["key"])
	}
}

func TestService_UploadTarget_RepeatedCallsSucceed(t *testing.T) {
	// Unlike the entryID-keyed getuploadtarget, a second request for the
	// same circle's cover photo must not be rejected — overwriting is the
	// whole point (see blobstore.Store.GetCoverPhotoUploadTarget).
	syncID, writeToken, founderPub, founderPriv, logStore := bootstrapWithFounder(t)
	signature := ed25519.Sign(founderPriv, logstore.CoverPhotoUploadMessage(syncID))

	service := &getcoverphotouploadtarget.Service{BlobStore: testsupport.NewBlobStore(t), LogStore: logStore}
	if _, err := service.UploadTarget(context.Background(), syncID, writeToken, hex.EncodeToString(founderPub), signature); err != nil {
		t.Fatal(err)
	}
	if _, err := service.UploadTarget(context.Background(), syncID, writeToken, hex.EncodeToString(founderPub), signature); err != nil {
		t.Fatalf("expected a second request for the same cover photo to succeed, got %v", err)
	}
}

func TestService_UploadTarget_RejectsWrongWriteToken(t *testing.T) {
	syncID, _, founderPub, founderPriv, logStore := bootstrapWithFounder(t)
	signature := ed25519.Sign(founderPriv, logstore.CoverPhotoUploadMessage(syncID))

	service := &getcoverphotouploadtarget.Service{BlobStore: testsupport.NewBlobStore(t), LogStore: logStore}
	_, err := service.UploadTarget(context.Background(), syncID, newToken(t), hex.EncodeToString(founderPub), signature)
	if !errors.Is(err, logstore.ErrWriteTokenMismatch) {
		t.Fatalf("expected ErrWriteTokenMismatch, got %v", err)
	}
}

func TestService_UploadTarget_RejectsAuthorityKeyNotInTheAuthoritySet(t *testing.T) {
	syncID, writeToken, _, _, logStore := bootstrapWithFounder(t)
	strangerPub, strangerPriv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	signature := ed25519.Sign(strangerPriv, logstore.CoverPhotoUploadMessage(syncID))

	service := &getcoverphotouploadtarget.Service{BlobStore: testsupport.NewBlobStore(t), LogStore: logStore}
	_, err = service.UploadTarget(context.Background(), syncID, writeToken, hex.EncodeToString(strangerPub), signature)
	if !errors.Is(err, logstore.ErrAuthorityNotRecognized) {
		t.Fatalf("expected ErrAuthorityNotRecognized, got %v", err)
	}
}

func TestService_UploadTarget_RejectsASignatureOverTheWrongMessage(t *testing.T) {
	// A signature valid for a different operation (e.g. rotate) must not
	// be accepted here — see logstore.CoverPhotoUploadMessage's doc
	// comment on why the message is domain-separated.
	syncID, writeToken, founderPub, founderPriv, logStore := bootstrapWithFounder(t)
	signature := ed25519.Sign(founderPriv, logstore.RotateMessage(syncID, "entry-1", "deadbeef"))

	service := &getcoverphotouploadtarget.Service{BlobStore: testsupport.NewBlobStore(t), LogStore: logStore}
	_, err := service.UploadTarget(context.Background(), syncID, writeToken, hex.EncodeToString(founderPub), signature)
	if !errors.Is(err, logstore.ErrInvalidSignature) {
		t.Fatalf("expected ErrInvalidSignature, got %v", err)
	}
}
