package synclog_test

import (
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"errors"
	"testing"

	"circle-relay/internal/synclog"
)

// fakeLogStore drives Service's own decisions without LocalStack — each
// method records its call and returns a canned result. Only Rotate has a
// real body; the rest panic until their operations migrate.
type fakeLogStore struct {
	rotateCalls []rotateCall
	rotateOut   synclog.CommitResult
	rotateErr   error
}

type rotateCall struct {
	syncID, entryID                                              string
	encryptedPayload                                             []byte
	currentKeyVersion                                            int64
	currentWriteTokenHash, newWriteTokenHash, authorityPublicKey string
}

func (f *fakeLogStore) Rotate(ctx context.Context, syncID, entryID string, encryptedPayload []byte, currentKeyVersion int64, currentWriteTokenHash, newWriteTokenHash, authorityPublicKey string) (synclog.CommitResult, error) {
	f.rotateCalls = append(f.rotateCalls, rotateCall{syncID, entryID, encryptedPayload, currentKeyVersion, currentWriteTokenHash, newWriteTokenHash, authorityPublicKey})
	return f.rotateOut, f.rotateErr
}

func (f *fakeLogStore) Bootstrap(ctx context.Context, syncID, founderAuthorityPublicKey, initialWriteTokenHash string) error {
	panic("fakeLogStore: Bootstrap not implemented")
}
func (f *fakeLogStore) Append(ctx context.Context, syncID string, ns synclog.Namespace, entryID string, encryptedPayload []byte, keyVersion int64, writeToken, authorIdentityPublicKey string) (synclog.CommitResult, error) {
	panic("fakeLogStore: Append not implemented")
}
func (f *fakeLogStore) ChangeAuthority(ctx context.Context, change synclog.AuthorityChange) (synclog.CommitResult, error) {
	panic("fakeLogStore: ChangeAuthority not implemented")
}
func (f *fakeLogStore) DeleteCircle(ctx context.Context, deletion synclog.CircleDeletion) (synclog.CommitResult, error) {
	panic("fakeLogStore: DeleteCircle not implemented")
}
func (f *fakeLogStore) DeleteEntry(ctx context.Context, deletion synclog.EntryDeletion) (synclog.CommitResult, error) {
	panic("fakeLogStore: DeleteEntry not implemented")
}
func (f *fakeLogStore) DeleteAuthorContent(ctx context.Context, deletion synclog.AuthorContentDeletion) (synclog.AuthorContentResult, error) {
	panic("fakeLogStore: DeleteAuthorContent not implemented")
}
func (f *fakeLogStore) Read(ctx context.Context, syncID string, ns synclog.Namespace, sinceEpoch int64) (synclog.FetchResult, error) {
	panic("fakeLogStore: Read not implemented")
}
func (f *fakeLogStore) Peek(ctx context.Context, syncIDs []string) (map[string]synclog.Epochs, error) {
	panic("fakeLogStore: Peek not implemented")
}
func (f *fakeLogStore) VerifyWriteToken(ctx context.Context, syncID, writeToken string) error {
	panic("fakeLogStore: VerifyWriteToken not implemented")
}
func (f *fakeLogStore) VerifyAuthoritySignature(ctx context.Context, syncID, authorityPublicKey string, message []byte, signature []byte) error {
	panic("fakeLogStore: VerifyAuthoritySignature not implemented")
}

var _ synclog.LogStore = (*fakeLogStore)(nil)

func newTestAuthorityKey(t *testing.T) (publicKeyHex string, private ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("failed to generate authority key: %v", err)
	}
	return hex.EncodeToString(pub), priv
}

func TestService_Rotate_RejectsAnInvalidSignatureBeforeTouchingStorage(t *testing.T) {
	pubKey, priv := newTestAuthorityKey(t)
	newHash := "aa"

	// A signature over the wrong message — as if forged, or replayed
	// from a different rotation.
	badSig := ed25519.Sign(priv, synclog.RotateMessage("sync-1", "some-other-entry", newHash))

	log := &fakeLogStore{}
	svc := &synclog.Service{Log: log}
	_, err := svc.Rotate(context.Background(), "sync-1", "rotate-1", []byte("payload"), 1, "deadbeef", newHash, pubKey, badSig)
	if !errors.Is(err, synclog.ErrInvalidSignature) {
		t.Fatalf("expected ErrInvalidSignature, got %v", err)
	}
	if len(log.rotateCalls) != 0 {
		t.Fatalf("expected LogStore.Rotate never called, got %d calls", len(log.rotateCalls))
	}
}

func TestService_Rotate_RejectsAMalformedCurrentWriteToken(t *testing.T) {
	pubKey, priv := newTestAuthorityKey(t)
	newHash := "aa"
	sig := ed25519.Sign(priv, synclog.RotateMessage("sync-1", "rotate-1", newHash))

	log := &fakeLogStore{}
	svc := &synclog.Service{Log: log}
	_, err := svc.Rotate(context.Background(), "sync-1", "rotate-1", []byte("payload"), 1, "not-hex", newHash, pubKey, sig)
	if !errors.Is(err, synclog.ErrWriteTokenMismatch) {
		t.Fatalf("expected ErrWriteTokenMismatch for a malformed token, got %v", err)
	}
	if len(log.rotateCalls) != 0 {
		t.Fatalf("expected LogStore.Rotate never called, got %d calls", len(log.rotateCalls))
	}
}

func TestService_Rotate_HashesTheCurrentTokenBeforeCallingLogStore(t *testing.T) {
	pubKey, priv := newTestAuthorityKey(t)
	newHash := "aa"
	sig := ed25519.Sign(priv, synclog.RotateMessage("sync-1", "rotate-1", newHash))

	log := &fakeLogStore{rotateOut: synclog.CommitResult{Epoch: 3, ReceivedAt: 100}}
	svc := &synclog.Service{Log: log}
	result, err := svc.Rotate(context.Background(), "sync-1", "rotate-1", []byte("payload"), 1, "deadbeef", newHash, pubKey, sig)
	if err != nil {
		t.Fatal(err)
	}
	if result != log.rotateOut {
		t.Fatalf("expected the LogStore's result passed through unchanged, got %+v", result)
	}
	if len(log.rotateCalls) != 1 {
		t.Fatalf("expected exactly one LogStore.Rotate call, got %d", len(log.rotateCalls))
	}
	wantHash, err := synclog.WriteTokenHash("deadbeef")
	if err != nil {
		t.Fatal(err)
	}
	if got := log.rotateCalls[0].currentWriteTokenHash; got != wantHash {
		t.Fatalf("expected the raw token hashed before reaching LogStore, got %q want %q", got, wantHash)
	}
	if got := log.rotateCalls[0].authorityPublicKey; got != pubKey {
		t.Fatalf("expected authorityPublicKey passed through, got %q", got)
	}
}
