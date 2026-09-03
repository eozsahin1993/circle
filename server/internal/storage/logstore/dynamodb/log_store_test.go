package dynamodb_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"testing"

	"circle-relay/internal/storage/logstore"
	"circle-relay/internal/testsupport"
)

// hashToken duplicates the adapter's private hashWriteToken (unexported,
// and this is an external _test package, same reasoning as the sort-key
// format duplication below) — sha256 over the raw bytes a hex-encoded
// write token decodes to.
func hashToken(t *testing.T, tokenHex string) string {
	t.Helper()
	raw, err := hex.DecodeString(tokenHex)
	if err != nil {
		t.Fatalf("test token isn't valid hex: %v", err)
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// newToken returns a fresh, random hex-encoded string standing in for a
// real writeToken (in reality HKDF(K_v, "relay-write-token")) — tests
// only care that two calls produce different values and that hashToken
// is stable for a given one, not about the real derivation. Must be valid
// hex, unlike testsupport.UniqueSyncID (which embeds the test name).
func newToken(t *testing.T) string {
	t.Helper()
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		t.Fatalf("failed to generate random token: %v", err)
	}
	return hex.EncodeToString(buf)
}

type authorityKey struct {
	publicKeyHex string
	private      ed25519.PrivateKey
}

func newAuthorityKey(t *testing.T) authorityKey {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("failed to generate authority key: %v", err)
	}
	return authorityKey{publicKeyHex: hex.EncodeToString(pub), private: priv}
}

func (k authorityKey) sign(syncID, entryID, newWriteTokenHash string) []byte {
	return ed25519.Sign(k.private, logstore.RotateMessage(syncID, entryID, newWriteTokenHash))
}

func bootstrap(t *testing.T, store logstore.Store, syncID string, founder authorityKey, token string) {
	t.Helper()
	if err := store.Bootstrap(context.Background(), syncID, founder.publicKeyHex, hashToken(t, token)); err != nil {
		t.Fatalf("bootstrap failed: %v", err)
	}
}

func TestLogStore_Bootstrap_RejectsDuplicateSyncID(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)

	bootstrap(t, store, syncID, founder, newToken(t))

	err := store.Bootstrap(ctx, syncID, founder.publicKeyHex, hashToken(t, newToken(t)))
	if !errors.Is(err, logstore.ErrAlreadyExists) {
		t.Fatalf("expected ErrAlreadyExists on a second Bootstrap, got %v", err)
	}
}

func TestLogStore_Append_SucceedsWithTheCurrentWriteTokenAndAssignsSequentialEpochs(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)

	first, err := store.Append(ctx, syncID, logstore.NamespaceMeta, "entry-1", []byte("ciphertext"), 1, token)
	if err != nil {
		t.Fatal(err)
	}
	if first.Epoch != 1 {
		t.Fatalf("expected first entry to land at epoch 1, got %d", first.Epoch)
	}

	second, err := store.Append(ctx, syncID, logstore.NamespaceMeta, "entry-2", []byte("ciphertext"), 1, token)
	if err != nil {
		t.Fatal(err)
	}
	if second.Epoch != 2 {
		t.Fatalf("expected second entry to land at epoch 2, got %d", second.Epoch)
	}
}

func TestLogStore_Append_RejectsWrongWriteTokenAndLeavesCounterUntouched(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)

	_, err := store.Append(ctx, syncID, logstore.NamespaceMeta, "entry-1", []byte("ciphertext"), 1, "not-the-real-token-hex")
	if !errors.Is(err, logstore.ErrWriteTokenMismatch) {
		t.Fatalf("expected ErrWriteTokenMismatch, got %v", err)
	}

	// A wrong token must never burn an epoch — the first entry with the
	// *correct* token still lands at epoch 1, not 2.
	commit, err := store.Append(ctx, syncID, logstore.NamespaceMeta, "entry-2", []byte("ciphertext"), 1, token)
	if err != nil {
		t.Fatal(err)
	}
	if commit.Epoch != 1 {
		t.Fatalf("expected the rejected attempt to have consumed no epoch, got epoch %d", commit.Epoch)
	}
}

func TestLogStore_Append_UnknownSyncIDIsDistinctFromWrongToken(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)

	_, err := store.Append(ctx, testsupport.UniqueSyncID(t), logstore.NamespaceMeta, "entry-1", []byte("ciphertext"), 1, newToken(t))
	if !errors.Is(err, logstore.ErrCircleNotFound) {
		t.Fatalf("expected ErrCircleNotFound for a never-bootstrapped syncID, got %v", err)
	}
}

func TestLogStore_Append_MetaAndContentCountersAreIndependent(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)

	metaCommit, err := store.Append(ctx, syncID, logstore.NamespaceMeta, "meta-1", []byte("m"), 1, token)
	if err != nil {
		t.Fatal(err)
	}
	content1, err := store.Append(ctx, syncID, logstore.NamespaceContent, "content-1", []byte("c1"), 1, token)
	if err != nil {
		t.Fatal(err)
	}
	content2, err := store.Append(ctx, syncID, logstore.NamespaceContent, "content-2", []byte("c2"), 1, token)
	if err != nil {
		t.Fatal(err)
	}

	if metaCommit.Epoch != 1 {
		t.Fatalf("expected meta's own first entry at epoch 1, got %d", metaCommit.Epoch)
	}
	if content1.Epoch != 1 || content2.Epoch != 2 {
		t.Fatalf("expected content's own independent sequence 1,2 — got %d,%d", content1.Epoch, content2.Epoch)
	}

	metaRead, err := store.Read(ctx, syncID, logstore.NamespaceMeta, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(metaRead.Entries) != 1 {
		t.Fatalf("expected exactly the one meta entry when reading meta, got %d (content must not leak into meta)", len(metaRead.Entries))
	}

	contentRead, err := store.Read(ctx, syncID, logstore.NamespaceContent, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(contentRead.Entries) != 2 {
		t.Fatalf("expected exactly the two content entries when reading content, got %d (meta must not leak into content)", len(contentRead.Entries))
	}
}

func TestLogStore_Append_ConcurrentDuplicateEntryIDsConvergeToSameEpoch(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)

	const concurrency = 10
	results := make([]logstore.CommitResult, concurrency)
	errs := make([]error, concurrency)

	var wg sync.WaitGroup
	wg.Add(concurrency)
	for i := range concurrency {
		go func() {
			defer wg.Done()
			results[i], errs[i] = store.Append(ctx, syncID, logstore.NamespaceContent, "post-1", []byte("ciphertext"), 1, token)
		}()
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("append %d failed: %v", i, err)
		}
	}
	want := results[0]
	for i, got := range results {
		if got != want {
			t.Fatalf("append %d = %+v, want %+v (all concurrent commits of the same entryID must converge)", i, got, want)
		}
	}
}

func TestLogStore_Rotate_SwapsWriteTokenAndAppendsMetaEntryAtomically(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	oldToken := newToken(t)
	newTokenValue := newToken(t)
	newHash := hashToken(t, newTokenValue)
	bootstrap(t, store, syncID, founder, oldToken)

	sig := founder.sign(syncID, "rotate-1", newHash)
	commit, err := store.Rotate(ctx, syncID, "rotate-1", []byte("key_rotation payload"), 1, oldToken, newHash, founder.publicKeyHex, sig)
	if err != nil {
		t.Fatal(err)
	}
	if commit.Epoch != 1 {
		t.Fatalf("expected the rotation to land as meta's first entry (epoch 1), got %d", commit.Epoch)
	}

	// The old token must no longer work...
	if _, err := store.Append(ctx, syncID, logstore.NamespaceContent, "post-with-old-token", []byte("c"), 1, oldToken); !errors.Is(err, logstore.ErrWriteTokenMismatch) {
		t.Fatalf("expected old write token to be rejected after rotation, got %v", err)
	}
	// ...and the new one must.
	if _, err := store.Append(ctx, syncID, logstore.NamespaceContent, "post-with-new-token", []byte("c"), 1, newTokenValue); err != nil {
		t.Fatalf("expected new write token to work after rotation: %v", err)
	}

	metaRead, err := store.Read(ctx, syncID, logstore.NamespaceMeta, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(metaRead.Entries) != 1 || string(metaRead.Entries[0].EncryptedMeta) != "key_rotation payload" {
		t.Fatalf("expected the rotation's own entry to be readable back from meta, got %+v", metaRead.Entries)
	}
}

func TestLogStore_Rotate_RejectsSignatureFromAKeyNotInTheAuthoritySet(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	impostor := newAuthorityKey(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)

	newHash := hashToken(t, newToken(t))
	sig := impostor.sign(syncID, "rotate-1", newHash)

	_, err := store.Rotate(ctx, syncID, "rotate-1", []byte("payload"), 1, token, newHash, impostor.publicKeyHex, sig)
	if !errors.Is(err, logstore.ErrAuthorityNotRecognized) {
		t.Fatalf("expected ErrAuthorityNotRecognized for a validly-signed but unrecognized authority key, got %v", err)
	}

	// Nothing should have moved: the original token still works.
	if _, err := store.Append(ctx, syncID, logstore.NamespaceContent, "post-1", []byte("c"), 1, token); err != nil {
		t.Fatalf("expected the original write token to still work after a rejected rotation: %v", err)
	}
}

func TestLogStore_Rotate_RejectsAnInvalidSignatureBeforeTouchingStorage(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)

	newHash := hashToken(t, newToken(t))
	// Correct, recognized public key, but a signature over the wrong
	// message (as if forged, or replayed from a different rotation).
	badSig := founder.sign(syncID, "some-other-entry-id", newHash)

	_, err := store.Rotate(ctx, syncID, "rotate-1", []byte("payload"), 1, token, newHash, founder.publicKeyHex, badSig)
	if !errors.Is(err, logstore.ErrInvalidSignature) {
		t.Fatalf("expected ErrInvalidSignature, got %v", err)
	}

	if _, err := store.Append(ctx, syncID, logstore.NamespaceContent, "post-1", []byte("c"), 1, token); err != nil {
		t.Fatalf("expected the original write token to still work after a rejected rotation: %v", err)
	}
}

func TestLogStore_Rotate_RejectsAStaleCurrentWriteToken(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)

	newHash := hashToken(t, newToken(t))
	sig := founder.sign(syncID, "rotate-1", newHash)

	_, err := store.Rotate(ctx, syncID, "rotate-1", []byte("payload"), 1, "stale-token-not-the-real-one", newHash, founder.publicKeyHex, sig)
	if !errors.Is(err, logstore.ErrWriteTokenMismatch) {
		t.Fatalf("expected ErrWriteTokenMismatch for a stale currentWriteToken, got %v", err)
	}
}

func TestLogStore_Read_UnbootstrappedSyncIDReadsAsEmptyNotError(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)

	result, err := store.Read(ctx, testsupport.UniqueSyncID(t), logstore.NamespaceMeta, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Entries) != 0 || result.CurrentEpoch != 0 {
		t.Fatalf("expected an empty result for a never-bootstrapped syncID, got %+v", result)
	}
}

// readPageSize duplicated from log_store.go (unexported, external _test
// package, same reasoning as elsewhere in this file).
const readPageSize = 200

// Proves Read() loops past DynamoDB's own internal per-call response cap
// instead of silently returning a truncated result, and that a caller
// resuming from the last entry it actually received (never from
// CurrentEpoch) picks up exactly where it left off — same property the
// pre-redesign version of this store had, now scoped to one namespace.
func TestLogStore_Read_PaginatesPastASinglePageAndResumesCorrectly(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)

	const totalEntries = readPageSize + 50
	for i := range totalEntries {
		if _, err := store.Append(ctx, syncID, logstore.NamespaceContent, fmt.Sprintf("post-%d", i), []byte("ciphertext"), 1, token); err != nil {
			t.Fatalf("append %d failed: %v", i, err)
		}
	}

	first, err := store.Read(ctx, syncID, logstore.NamespaceContent, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Entries) != readPageSize {
		t.Fatalf("expected exactly %d entries in a capped page, got %d", readPageSize, len(first.Entries))
	}
	if first.CurrentEpoch != int64(totalEntries) {
		t.Fatalf("expected CurrentEpoch to report the true latest (%d) even though this page was truncated, got %d", totalEntries, first.CurrentEpoch)
	}
	lastInFirstPage := first.Entries[len(first.Entries)-1].Epoch
	if lastInFirstPage != readPageSize {
		t.Fatalf("expected the first page's last entry to be epoch %d, got %d", readPageSize, lastInFirstPage)
	}

	second, err := store.Read(ctx, syncID, logstore.NamespaceContent, lastInFirstPage)
	if err != nil {
		t.Fatal(err)
	}
	wantRemaining := totalEntries - readPageSize
	if len(second.Entries) != wantRemaining {
		t.Fatalf("expected the remaining %d entries on the second page, got %d", wantRemaining, len(second.Entries))
	}
	if second.Entries[0].Epoch != readPageSize+1 {
		t.Fatalf("expected the second page to pick up right after the first left off, got first epoch %d", second.Entries[0].Epoch)
	}
	if second.Entries[len(second.Entries)-1].Epoch != int64(totalEntries) {
		t.Fatalf("expected the second page to reach the true latest epoch %d, got %d", totalEntries, second.Entries[len(second.Entries)-1].Epoch)
	}
}
