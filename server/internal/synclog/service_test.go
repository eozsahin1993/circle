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
// migrated method records its call and returns a canned result; the rest
// panic until their operations migrate.
type fakeLogStore struct {
	rotateCalls []rotateCall
	rotateOut   synclog.CommitResult
	rotateErr   error

	changeAuthorityCalls []changeAuthorityCall
	changeAuthorityOut   synclog.CommitResult
	changeAuthorityErr   error

	deleteCircleCalls []deleteCircleCall
	deleteCircleOut   synclog.CommitResult
	deleteCircleErr   error

	findEntryOut synclog.LogEntry
	findEntryErr error

	deleteEntryCalls []deleteEntryCall
	deleteEntryOut   synclog.CommitResult
	deleteEntryErr   error

	appendCalls []appendCall
	appendOut   synclog.CommitResult
	appendErr   error
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

type changeAuthorityCall struct {
	syncID, entryID                                    string
	encryptedPayload                                   []byte
	keyVersion                                         int64
	writeTokenHash                                     string
	action                                             synclog.AuthorityAction
	targetAuthorityPublicKey, signerAuthorityPublicKey string
}

func (f *fakeLogStore) ChangeAuthority(ctx context.Context, syncID, entryID string, encryptedPayload []byte, keyVersion int64, writeTokenHash string, action synclog.AuthorityAction, targetAuthorityPublicKey, signerAuthorityPublicKey string) (synclog.CommitResult, error) {
	f.changeAuthorityCalls = append(f.changeAuthorityCalls, changeAuthorityCall{syncID, entryID, encryptedPayload, keyVersion, writeTokenHash, action, targetAuthorityPublicKey, signerAuthorityPublicKey})
	return f.changeAuthorityOut, f.changeAuthorityErr
}

func (f *fakeLogStore) Bootstrap(ctx context.Context, syncID, founderAuthorityPublicKey, initialWriteTokenHash string) error {
	panic("fakeLogStore: Bootstrap not implemented")
}

type appendCall struct {
	syncID                                  string
	ns                                      synclog.Namespace
	entryID                                 string
	encryptedPayload                        []byte
	keyVersion                              int64
	writeTokenHash, authorIdentityPublicKey string
}

func (f *fakeLogStore) Append(ctx context.Context, syncID string, ns synclog.Namespace, entryID string, encryptedPayload []byte, keyVersion int64, writeTokenHash, authorIdentityPublicKey string) (synclog.CommitResult, error) {
	f.appendCalls = append(f.appendCalls, appendCall{syncID, ns, entryID, encryptedPayload, keyVersion, writeTokenHash, authorIdentityPublicKey})
	return f.appendOut, f.appendErr
}

type deleteCircleCall struct {
	syncID, entryID          string
	encryptedPayload         []byte
	keyVersion               int64
	writeTokenHash           string
	signerAuthorityPublicKey string
}

func (f *fakeLogStore) DeleteCircle(ctx context.Context, syncID, entryID string, encryptedPayload []byte, keyVersion int64, writeTokenHash string, signerAuthorityPublicKey string) (synclog.CommitResult, error) {
	f.deleteCircleCalls = append(f.deleteCircleCalls, deleteCircleCall{syncID, entryID, encryptedPayload, keyVersion, writeTokenHash, signerAuthorityPublicKey})
	return f.deleteCircleOut, f.deleteCircleErr
}
func (f *fakeLogStore) FindEntry(ctx context.Context, syncID, entryID string) (synclog.LogEntry, error) {
	return f.findEntryOut, f.findEntryErr
}

type deleteEntryCall struct {
	syncID, tombstoneEntryID     string
	targetEpoch                  int64
	encryptedPayload             []byte
	keyVersion                   int64
	writeTokenHash, authorizedBy string
	requiredAuthorityPublicKey   string
}

func (f *fakeLogStore) DeleteEntry(ctx context.Context, syncID, tombstoneEntryID string, targetEpoch int64, encryptedPayload []byte, keyVersion int64, writeTokenHash, authorizedBy, requiredAuthorityPublicKey string) (synclog.CommitResult, error) {
	f.deleteEntryCalls = append(f.deleteEntryCalls, deleteEntryCall{syncID, tombstoneEntryID, targetEpoch, encryptedPayload, keyVersion, writeTokenHash, authorizedBy, requiredAuthorityPublicKey})
	return f.deleteEntryOut, f.deleteEntryErr
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

// newTestAuthorityChange builds a fully, correctly signed AuthorityChange
// — tests that want a wrong one edit a field after the fact.
func newTestAuthorityChange(signerPub string, signerPriv ed25519.PrivateKey, syncID, entryID string, action synclog.AuthorityAction, target, token string) synclog.AuthorityChange {
	change := synclog.AuthorityChange{
		SyncID:                   syncID,
		EntryID:                  entryID,
		EncryptedPayload:         []byte("role_change payload"),
		KeyVersion:               1,
		WriteToken:               token,
		Action:                   action,
		TargetAuthorityPublicKey: target,
		SignerAuthorityPublicKey: signerPub,
	}
	change.Signature = ed25519.Sign(signerPriv, change.Message())
	return change
}

func TestService_ChangeAuthority_RejectsAnUnknownAction(t *testing.T) {
	pubKey, priv := newTestAuthorityKey(t)
	change := newTestAuthorityChange(pubKey, priv, "sync-1", "promote-1", synclog.AuthorityAdd, pubKey, "deadbeef")
	change.Action = "replace"

	log := &fakeLogStore{}
	svc := &synclog.Service{Log: log}
	_, err := svc.ChangeAuthority(context.Background(), change)
	if !errors.Is(err, synclog.ErrInvalidAuthorityAction) {
		t.Fatalf("expected ErrInvalidAuthorityAction, got %v", err)
	}
	if len(log.changeAuthorityCalls) != 0 {
		t.Fatalf("expected LogStore.ChangeAuthority never called, got %d calls", len(log.changeAuthorityCalls))
	}
}

func TestService_ChangeAuthority_RejectsAMalformedTargetKey(t *testing.T) {
	pubKey, priv := newTestAuthorityKey(t)
	for name, target := range map[string]string{"not hex": "zzzz", "wrong size": "aabbcc"} {
		change := newTestAuthorityChange(pubKey, priv, "sync-1", "promote-1", synclog.AuthorityAdd, target, "deadbeef")

		log := &fakeLogStore{}
		svc := &synclog.Service{Log: log}
		_, err := svc.ChangeAuthority(context.Background(), change)
		if !errors.Is(err, synclog.ErrInvalidAuthorityKey) {
			t.Fatalf("%s: expected ErrInvalidAuthorityKey, got %v", name, err)
		}
	}
}

// The signature covers the action, so authorizing a promotion can't be
// turned into the demotion of the same person by editing one field.
func TestService_ChangeAuthority_SignatureDoesNotCarryAcrossActions(t *testing.T) {
	pubKey, priv := newTestAuthorityKey(t)
	targetKey, _ := newTestAuthorityKey(t)
	change := newTestAuthorityChange(pubKey, priv, "sync-1", "demote-1", synclog.AuthorityAdd, targetKey, "deadbeef")
	change.Action = synclog.AuthorityRemove

	log := &fakeLogStore{}
	svc := &synclog.Service{Log: log}
	_, err := svc.ChangeAuthority(context.Background(), change)
	if !errors.Is(err, synclog.ErrInvalidSignature) {
		t.Fatalf("expected an add signature to be useless for a remove, got %v", err)
	}
	if len(log.changeAuthorityCalls) != 0 {
		t.Fatalf("expected LogStore.ChangeAuthority never called, got %d calls", len(log.changeAuthorityCalls))
	}
}

// ...nor across circles, which is what binding the message to syncID buys.
func TestService_ChangeAuthority_SignatureDoesNotCarryAcrossCircles(t *testing.T) {
	pubKey, priv := newTestAuthorityKey(t)
	targetKey, _ := newTestAuthorityKey(t)
	change := newTestAuthorityChange(pubKey, priv, "sync-a", "promote-1", synclog.AuthorityAdd, targetKey, "deadbeef")
	change.SyncID = "sync-b"

	log := &fakeLogStore{}
	svc := &synclog.Service{Log: log}
	_, err := svc.ChangeAuthority(context.Background(), change)
	if !errors.Is(err, synclog.ErrInvalidSignature) {
		t.Fatalf("expected a signature bound to another circle to be rejected, got %v", err)
	}
	if len(log.changeAuthorityCalls) != 0 {
		t.Fatalf("expected LogStore.ChangeAuthority never called, got %d calls", len(log.changeAuthorityCalls))
	}
}

func TestService_ChangeAuthority_HashesTheWriteTokenBeforeCallingLogStore(t *testing.T) {
	pubKey, priv := newTestAuthorityKey(t)
	targetKey, _ := newTestAuthorityKey(t)
	change := newTestAuthorityChange(pubKey, priv, "sync-1", "promote-1", synclog.AuthorityAdd, targetKey, "deadbeef")

	log := &fakeLogStore{changeAuthorityOut: synclog.CommitResult{Epoch: 2, ReceivedAt: 200}}
	svc := &synclog.Service{Log: log}
	result, err := svc.ChangeAuthority(context.Background(), change)
	if err != nil {
		t.Fatal(err)
	}
	if result != log.changeAuthorityOut {
		t.Fatalf("expected the LogStore's result passed through unchanged, got %+v", result)
	}
	if len(log.changeAuthorityCalls) != 1 {
		t.Fatalf("expected exactly one LogStore.ChangeAuthority call, got %d", len(log.changeAuthorityCalls))
	}
	wantHash, err := synclog.WriteTokenHash("deadbeef")
	if err != nil {
		t.Fatal(err)
	}
	if got := log.changeAuthorityCalls[0].writeTokenHash; got != wantHash {
		t.Fatalf("expected the raw token hashed before reaching LogStore, got %q want %q", got, wantHash)
	}
}

// newTestCircleDeletion builds a fully, correctly signed CircleDeletion —
// same convention as newTestAuthorityChange.
func newTestCircleDeletion(signerPub string, signerPriv ed25519.PrivateKey, syncID, entryID, token string) synclog.CircleDeletion {
	deletion := synclog.CircleDeletion{
		SyncID:                   syncID,
		EntryID:                  entryID,
		EncryptedPayload:         []byte("circle_deleted payload"),
		KeyVersion:               1,
		WriteToken:               token,
		SignerAuthorityPublicKey: signerPub,
	}
	deletion.Signature = ed25519.Sign(signerPriv, deletion.Message())
	return deletion
}

func TestService_DeleteCircle_RejectsAMalformedWriteToken(t *testing.T) {
	pubKey, priv := newTestAuthorityKey(t)
	deletion := newTestCircleDeletion(pubKey, priv, "sync-1", "tombstone-1", "not-hex")

	log := &fakeLogStore{}
	svc := &synclog.Service{Log: log}
	_, err := svc.DeleteCircle(context.Background(), deletion)
	if !errors.Is(err, synclog.ErrWriteTokenMismatch) {
		t.Fatalf("expected ErrWriteTokenMismatch for a malformed token, got %v", err)
	}
	if len(log.deleteCircleCalls) != 0 {
		t.Fatalf("expected LogStore.DeleteCircle never called, got %d calls", len(log.deleteCircleCalls))
	}
}

// A signature made for one circle must not authorize deleting another.
func TestService_DeleteCircle_SignatureDoesNotCarryAcrossCircles(t *testing.T) {
	pubKey, priv := newTestAuthorityKey(t)
	deletion := newTestCircleDeletion(pubKey, priv, "sync-a", "tombstone-1", "deadbeef")
	deletion.SyncID = "sync-b"

	log := &fakeLogStore{}
	svc := &synclog.Service{Log: log}
	_, err := svc.DeleteCircle(context.Background(), deletion)
	if !errors.Is(err, synclog.ErrInvalidSignature) {
		t.Fatalf("expected a signature bound to another circle to be rejected, got %v", err)
	}
	if len(log.deleteCircleCalls) != 0 {
		t.Fatalf("expected LogStore.DeleteCircle never called, got %d calls", len(log.deleteCircleCalls))
	}
}

func TestService_DeleteCircle_HashesTheWriteTokenBeforeCallingLogStore(t *testing.T) {
	pubKey, priv := newTestAuthorityKey(t)
	deletion := newTestCircleDeletion(pubKey, priv, "sync-1", "tombstone-1", "deadbeef")

	log := &fakeLogStore{deleteCircleOut: synclog.CommitResult{Epoch: 4, ReceivedAt: 300}}
	svc := &synclog.Service{Log: log}
	result, err := svc.DeleteCircle(context.Background(), deletion)
	if err != nil {
		t.Fatal(err)
	}
	if result != log.deleteCircleOut {
		t.Fatalf("expected the LogStore's result passed through unchanged, got %+v", result)
	}
	if len(log.deleteCircleCalls) != 1 {
		t.Fatalf("expected exactly one LogStore.DeleteCircle call, got %d", len(log.deleteCircleCalls))
	}
	wantHash, err := synclog.WriteTokenHash("deadbeef")
	if err != nil {
		t.Fatal(err)
	}
	if got := log.deleteCircleCalls[0].writeTokenHash; got != wantHash {
		t.Fatalf("expected the raw token hashed before reaching LogStore, got %q want %q", got, wantHash)
	}
}

// newTestEntryDeletion builds an EntryDeletion signed by authorPriv over
// the deletion — tests that want a wrong signature, or the admin path
// instead, replace AuthorSignature after the fact.
func newTestEntryDeletion(syncID, targetEntryID, tombstoneEntryID string, authorPriv ed25519.PrivateKey, token string) synclog.EntryDeletion {
	deletion := synclog.EntryDeletion{
		SyncID:           syncID,
		TargetEntryID:    targetEntryID,
		TombstoneEntryID: tombstoneEntryID,
		EncryptedPayload: []byte("post_delete payload"),
		KeyVersion:       1,
		WriteToken:       token,
	}
	deletion.AuthorSignature = ed25519.Sign(authorPriv, deletion.Message())
	return deletion
}

func TestService_DeleteEntry_SucceedsViaAuthorSignature(t *testing.T) {
	authorPub, authorPriv := newTestAuthorityKey(t)
	deletion := newTestEntryDeletion("sync-1", "post-1", "tombstone-1", authorPriv, "deadbeef")

	log := &fakeLogStore{
		findEntryOut:   synclog.LogEntry{Epoch: 3, AuthorIdentityPublicKey: authorPub},
		deleteEntryOut: synclog.CommitResult{Epoch: 4, ReceivedAt: 500},
	}
	svc := &synclog.Service{Log: log}
	result, err := svc.DeleteEntry(context.Background(), deletion)
	if err != nil {
		t.Fatal(err)
	}
	if result != log.deleteEntryOut {
		t.Fatalf("expected the LogStore's result passed through unchanged, got %+v", result)
	}
	if len(log.deleteEntryCalls) != 1 {
		t.Fatalf("expected exactly one LogStore.DeleteEntry call, got %d", len(log.deleteEntryCalls))
	}
	call := log.deleteEntryCalls[0]
	if call.targetEpoch != 3 {
		t.Fatalf("expected the post's epoch passed through, got %d", call.targetEpoch)
	}
	if call.authorizedBy != authorPub {
		t.Fatalf("expected authorizedBy to be the author's key, got %q", call.authorizedBy)
	}
	if call.requiredAuthorityPublicKey != "" {
		t.Fatalf("expected no authoritySet check on the author path, got %q", call.requiredAuthorityPublicKey)
	}
	wantHash, err := synclog.WriteTokenHash("deadbeef")
	if err != nil {
		t.Fatal(err)
	}
	if call.writeTokenHash != wantHash {
		t.Fatalf("expected the raw token hashed before reaching LogStore, got %q want %q", call.writeTokenHash, wantHash)
	}
}

// The impostor's signature doesn't match the post's real author, and no
// authority pair is offered — the same request an outsider forging a
// delete would send.
func TestService_DeleteEntry_RejectsWrongSignature(t *testing.T) {
	authorPub, _ := newTestAuthorityKey(t)
	_, impostorPriv := newTestAuthorityKey(t)
	deletion := newTestEntryDeletion("sync-1", "post-1", "tombstone-1", impostorPriv, "deadbeef")

	log := &fakeLogStore{findEntryOut: synclog.LogEntry{Epoch: 3, AuthorIdentityPublicKey: authorPub}}
	svc := &synclog.Service{Log: log}
	_, err := svc.DeleteEntry(context.Background(), deletion)
	if !errors.Is(err, synclog.ErrEntryNotAuthorized) {
		t.Fatalf("expected ErrEntryNotAuthorized, got %v", err)
	}
	if len(log.deleteEntryCalls) != 0 {
		t.Fatalf("expected LogStore.DeleteEntry never called, got %d calls", len(log.deleteEntryCalls))
	}
}

// A circle admin deleting someone else's post: no AuthorSignature, an
// AuthorityPublicKey/AuthoritySignature pair instead. requiredAuthorityPublicKey
// carries the admin's key through to LogStore rather than being checked
// here — authoritySet membership has to be re-verified atomically inside
// the same commit that lands the tombstone, not against a moment-earlier
// read (the TOCTOU DeleteEntry's admin path used to have).
func TestService_DeleteEntry_FallsBackToAuthoritySignatureAndDefersMembership(t *testing.T) {
	authorPub, _ := newTestAuthorityKey(t)
	adminPub, adminPriv := newTestAuthorityKey(t)
	deletion := synclog.EntryDeletion{
		SyncID:             "sync-1",
		TargetEntryID:      "post-1",
		TombstoneEntryID:   "tombstone-1",
		EncryptedPayload:   []byte("post_delete payload"),
		KeyVersion:         1,
		WriteToken:         "deadbeef",
		AuthorityPublicKey: adminPub,
	}
	deletion.AuthoritySignature = ed25519.Sign(adminPriv, deletion.Message())

	log := &fakeLogStore{findEntryOut: synclog.LogEntry{Epoch: 3, AuthorIdentityPublicKey: authorPub}}
	svc := &synclog.Service{Log: log}
	if _, err := svc.DeleteEntry(context.Background(), deletion); err != nil {
		t.Fatal(err)
	}
	if len(log.deleteEntryCalls) != 1 {
		t.Fatalf("expected exactly one LogStore.DeleteEntry call, got %d", len(log.deleteEntryCalls))
	}
	call := log.deleteEntryCalls[0]
	if call.authorizedBy != adminPub {
		t.Fatalf("expected authorizedBy to be the admin's key, got %q", call.authorizedBy)
	}
	if call.requiredAuthorityPublicKey != adminPub {
		t.Fatalf("expected requiredAuthorityPublicKey passed through for LogStore to re-check atomically, got %q", call.requiredAuthorityPublicKey)
	}
}

func TestService_DeleteEntry_RejectsAnInvalidAuthoritySignature(t *testing.T) {
	authorPub, _ := newTestAuthorityKey(t)
	adminPub, _ := newTestAuthorityKey(t)
	_, impostorPriv := newTestAuthorityKey(t)
	deletion := synclog.EntryDeletion{
		SyncID:             "sync-1",
		TargetEntryID:      "post-1",
		TombstoneEntryID:   "tombstone-1",
		EncryptedPayload:   []byte("post_delete payload"),
		KeyVersion:         1,
		WriteToken:         "deadbeef",
		AuthorityPublicKey: adminPub,
	}
	deletion.AuthoritySignature = ed25519.Sign(impostorPriv, deletion.Message())

	log := &fakeLogStore{findEntryOut: synclog.LogEntry{Epoch: 3, AuthorIdentityPublicKey: authorPub}}
	svc := &synclog.Service{Log: log}
	_, err := svc.DeleteEntry(context.Background(), deletion)
	if !errors.Is(err, synclog.ErrInvalidSignature) {
		t.Fatalf("expected ErrInvalidSignature, got %v", err)
	}
	if len(log.deleteEntryCalls) != 0 {
		t.Fatalf("expected LogStore.DeleteEntry never called, got %d calls", len(log.deleteEntryCalls))
	}
}

func TestService_DeleteEntry_RejectsAMalformedWriteToken(t *testing.T) {
	authorPub, authorPriv := newTestAuthorityKey(t)
	deletion := newTestEntryDeletion("sync-1", "post-1", "tombstone-1", authorPriv, "not-hex")

	log := &fakeLogStore{findEntryOut: synclog.LogEntry{Epoch: 3, AuthorIdentityPublicKey: authorPub}}
	svc := &synclog.Service{Log: log}
	_, err := svc.DeleteEntry(context.Background(), deletion)
	if !errors.Is(err, synclog.ErrWriteTokenMismatch) {
		t.Fatalf("expected ErrWriteTokenMismatch for a malformed token, got %v", err)
	}
	if len(log.deleteEntryCalls) != 0 {
		t.Fatalf("expected LogStore.DeleteEntry never called, got %d calls", len(log.deleteEntryCalls))
	}
}

func TestService_DeleteEntry_PropagatesFindEntryError(t *testing.T) {
	log := &fakeLogStore{findEntryErr: synclog.ErrEntryNotFound}
	svc := &synclog.Service{Log: log}
	_, err := svc.DeleteEntry(context.Background(), synclog.EntryDeletion{SyncID: "sync-1", TargetEntryID: "no-such-post", TombstoneEntryID: "tombstone-1"})
	if !errors.Is(err, synclog.ErrEntryNotFound) {
		t.Fatalf("expected ErrEntryNotFound, got %v", err)
	}
	if len(log.deleteEntryCalls) != 0 {
		t.Fatalf("expected LogStore.DeleteEntry never called, got %d calls", len(log.deleteEntryCalls))
	}
}

func TestService_Append_RejectsAMalformedWriteToken(t *testing.T) {
	log := &fakeLogStore{}
	svc := &synclog.Service{Log: log}
	_, err := svc.Append(context.Background(), "sync-1", synclog.NamespaceContent, "post-1", []byte("ciphertext"), 1, "not-hex", "author-key")
	if !errors.Is(err, synclog.ErrWriteTokenMismatch) {
		t.Fatalf("expected ErrWriteTokenMismatch for a malformed token, got %v", err)
	}
	if len(log.appendCalls) != 0 {
		t.Fatalf("expected LogStore.Append never called, got %d calls", len(log.appendCalls))
	}
}

func TestService_Append_HashesTheWriteTokenBeforeCallingLogStore(t *testing.T) {
	log := &fakeLogStore{appendOut: synclog.CommitResult{Epoch: 1, ReceivedAt: 100}}
	svc := &synclog.Service{Log: log}
	result, err := svc.Append(context.Background(), "sync-1", synclog.NamespaceContent, "post-1", []byte("ciphertext"), 1, "deadbeef", "author-key")
	if err != nil {
		t.Fatal(err)
	}
	if result != log.appendOut {
		t.Fatalf("expected the LogStore's result passed through unchanged, got %+v", result)
	}
	if len(log.appendCalls) != 1 {
		t.Fatalf("expected exactly one LogStore.Append call, got %d", len(log.appendCalls))
	}
	wantHash, err := synclog.WriteTokenHash("deadbeef")
	if err != nil {
		t.Fatal(err)
	}
	if got := log.appendCalls[0].writeTokenHash; got != wantHash {
		t.Fatalf("expected the raw token hashed before reaching LogStore, got %q want %q", got, wantHash)
	}
	if got := log.appendCalls[0].authorIdentityPublicKey; got != "author-key" {
		t.Fatalf("expected authorIdentityPublicKey passed through, got %q", got)
	}
}
