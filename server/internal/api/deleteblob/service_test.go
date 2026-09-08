package deleteblob_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"testing"

	"circle-relay/internal/api/deleteblob"
	"circle-relay/internal/storage/blobstore"
	"circle-relay/internal/storage/logstore"
	"circle-relay/internal/testsupport"
)

const (
	uploaderAccount = "google:uploader"
	otherAccount    = "google:someone-else"
	entryID         = "entry-1"
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

type circle struct {
	syncID      string
	writeToken  string
	founderPub  ed25519.PublicKey
	founderPriv ed25519.PrivateKey
	service     *deleteblob.Service
	blobStore   blobstore.Store
}

// newCircle bootstraps a circle and uploads one blob as `uploaderAccount`,
// so every test below starts from a blob that genuinely exists and carries
// a known uploader.
func newCircle(t *testing.T) circle {
	t.Helper()
	ctx := context.Background()

	founderPub, founderPriv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	syncID := testsupport.UniqueSyncID(t)
	writeToken := newToken(t)
	logStore := testsupport.NewLogStore(t)
	if err := logStore.Bootstrap(ctx, syncID, hex.EncodeToString(founderPub), hashToken(writeToken)); err != nil {
		t.Fatal(err)
	}

	blobStore := testsupport.NewBlobStore(t)
	target, err := blobStore.GetUploadTarget(ctx, syncID, entryID, uploaderAccount)
	if err != nil {
		t.Fatal(err)
	}
	testsupport.UploadBlob(t, target, []byte("ciphertext"))

	return circle{
		syncID:      syncID,
		writeToken:  writeToken,
		founderPub:  founderPub,
		founderPriv: founderPriv,
		service:     &deleteblob.Service{BlobStore: blobStore, LogStore: logStore},
		blobStore:   blobStore,
	}
}

func (c circle) gone(t *testing.T) bool {
	t.Helper()
	_, err := c.blobStore.UploaderAccountID(context.Background(), c.syncID, entryID)
	return errors.Is(err, blobstore.ErrBlobNotFound)
}

func TestService_Delete_AllowsTheAccountThatUploaded(t *testing.T) {
	c := newCircle(t)

	if err := c.service.Delete(context.Background(), c.syncID, entryID, c.writeToken, uploaderAccount, "", nil); err != nil {
		t.Fatal(err)
	}
	if !c.gone(t) {
		t.Fatal("expected the blob to be deleted")
	}
}

/**
 * The gap this endpoint exists to close carefully: a member who is not
 * the uploader can't destroy bytes just by holding the write token. Their
 * forged `post_delete` entry would be rejected by every device's
 * predicate, but a deleted blob nothing could undo.
 */
func TestService_Delete_RefusesAnotherMemberWithNoSignature(t *testing.T) {
	c := newCircle(t)

	err := c.service.Delete(context.Background(), c.syncID, entryID, c.writeToken, otherAccount, "", nil)
	if !errors.Is(err, deleteblob.ErrNotUploader) {
		t.Fatalf("expected ErrNotUploader, got %v", err)
	}
	if c.gone(t) {
		t.Fatal("expected the blob to survive a refused delete")
	}
}

func TestService_Delete_AllowsAnAdminWhoDidNotUpload(t *testing.T) {
	c := newCircle(t)
	signature := ed25519.Sign(c.founderPriv, logstore.DeleteBlobMessage(c.syncID, entryID))

	err := c.service.Delete(
		context.Background(), c.syncID, entryID, c.writeToken, otherAccount, hex.EncodeToString(c.founderPub), signature,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !c.gone(t) {
		t.Fatal("expected the blob to be deleted")
	}
}

func TestService_Delete_RejectsAnAuthorityKeyNotInTheAuthoritySet(t *testing.T) {
	c := newCircle(t)
	strangerPub, strangerPriv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	signature := ed25519.Sign(strangerPriv, logstore.DeleteBlobMessage(c.syncID, entryID))

	err = c.service.Delete(
		context.Background(), c.syncID, entryID, c.writeToken, otherAccount, hex.EncodeToString(strangerPub), signature,
	)
	if !errors.Is(err, logstore.ErrAuthorityNotRecognized) {
		t.Fatalf("expected ErrAuthorityNotRecognized, got %v", err)
	}
}

/** Bound to the entry, so an admin's signature can't be replayed against a different photo. */
func TestService_Delete_RejectsASignatureOverAnotherEntry(t *testing.T) {
	c := newCircle(t)
	signature := ed25519.Sign(c.founderPriv, logstore.DeleteBlobMessage(c.syncID, "some-other-entry"))

	err := c.service.Delete(
		context.Background(), c.syncID, entryID, c.writeToken, otherAccount, hex.EncodeToString(c.founderPub), signature,
	)
	if !errors.Is(err, logstore.ErrInvalidSignature) {
		t.Fatalf("expected ErrInvalidSignature, got %v", err)
	}
}

func TestService_Delete_RejectsAWrongWriteToken(t *testing.T) {
	c := newCircle(t)

	err := c.service.Delete(context.Background(), c.syncID, entryID, newToken(t), uploaderAccount, "", nil)
	if !errors.Is(err, logstore.ErrWriteTokenMismatch) {
		t.Fatalf("expected ErrWriteTokenMismatch, got %v", err)
	}
}

/** The client retries until it sticks, so the attempt after a successful one must not read as a failure. */
func TestService_Delete_IsIdempotent(t *testing.T) {
	c := newCircle(t)
	ctx := context.Background()

	if err := c.service.Delete(ctx, c.syncID, entryID, c.writeToken, uploaderAccount, "", nil); err != nil {
		t.Fatal(err)
	}
	if err := c.service.Delete(ctx, c.syncID, entryID, c.writeToken, uploaderAccount, "", nil); err != nil {
		t.Fatalf("expected deleting an already-deleted blob to succeed, got %v", err)
	}
}
