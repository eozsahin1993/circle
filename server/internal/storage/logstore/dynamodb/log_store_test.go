package dynamodb_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"testing"
	"time"

	ddbtypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

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

// authorityChange builds a fully-populated, correctly-signed
// AuthorityChange — tests that want a *wrong* one edit a field after the
// signature is made, which is exactly the tamper each is checking for.
func authorityChange(signer authorityKey, syncID, entryID string, action logstore.AuthorityAction, target, token string) logstore.AuthorityChange {
	change := logstore.AuthorityChange{
		SyncID:                   syncID,
		EntryID:                  entryID,
		EncryptedPayload:         []byte("role_change payload"),
		KeyVersion:               1,
		WriteToken:               token,
		Action:                   action,
		TargetAuthorityPublicKey: target,
		SignerAuthorityPublicKey: signer.publicKeyHex,
	}
	change.Signature = ed25519.Sign(signer.private, change.Message())
	return change
}

// grant promotes target by adding its key to syncID's authority set,
// signed by signer — the setup step for every test that needs a second
// admin, which nothing but ChangeAuthority can produce.
func grant(t *testing.T, store logstore.Store, syncID, entryID string, signer, target authorityKey, token string) {
	t.Helper()
	if _, err := store.ChangeAuthority(context.Background(), authorityChange(signer, syncID, entryID, logstore.AuthorityAdd, target.publicKeyHex, token)); err != nil {
		t.Fatalf("granting authority failed: %v", err)
	}
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

// Proves Peek reports the same counters Read itself would, for every
// namespace, across several circles in a single call — the whole point of
// exposing it separately is that a poller shouldn't need one call per circle.
func TestLogStore_Peek_ReportsCurrentEpochsAcrossMultipleCircles(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	founder := newAuthorityKey(t)

	syncIDA := testsupport.UniqueSyncID(t)
	tokenA := newToken(t)
	bootstrap(t, store, syncIDA, founder, tokenA)
	if _, err := store.Append(ctx, syncIDA, logstore.NamespaceMeta, "a-meta-1", []byte("m"), 1, tokenA); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Append(ctx, syncIDA, logstore.NamespaceContent, "a-content-1", []byte("c"), 1, tokenA); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Append(ctx, syncIDA, logstore.NamespaceContent, "a-content-2", []byte("c"), 1, tokenA); err != nil {
		t.Fatal(err)
	}

	syncIDB := testsupport.UniqueSyncID(t)
	tokenB := newToken(t)
	bootstrap(t, store, syncIDB, founder, tokenB)
	if _, err := store.Append(ctx, syncIDB, logstore.NamespaceMeta, "b-meta-1", []byte("m"), 1, tokenB); err != nil {
		t.Fatal(err)
	}

	epochs, err := store.Peek(ctx, []string{syncIDA, syncIDB})
	if err != nil {
		t.Fatal(err)
	}
	if got := epochs[syncIDA]; got.Meta != 1 || got.Content != 2 {
		t.Fatalf("circle A: expected meta=1 content=2, got meta=%d content=%d", got.Meta, got.Content)
	}
	if got := epochs[syncIDB]; got.Meta != 1 || got.Content != 0 {
		t.Fatalf("circle B: expected meta=1 content=0, got meta=%d content=%d", got.Meta, got.Content)
	}
}

// A syncID with no #control item (never bootstrapped) is simply absent
// from the result — one bad/stale id in a batch must not fail the rest.
func TestLogStore_Peek_OmitsAnUnknownSyncIDWithoutErroringTheWholeBatch(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	founder := newAuthorityKey(t)

	knownSyncID := testsupport.UniqueSyncID(t)
	token := newToken(t)
	bootstrap(t, store, knownSyncID, founder, token)
	if _, err := store.Append(ctx, knownSyncID, logstore.NamespaceMeta, "m-1", []byte("m"), 1, token); err != nil {
		t.Fatal(err)
	}
	unknownSyncID := testsupport.UniqueSyncID(t)

	epochs, err := store.Peek(ctx, []string{knownSyncID, unknownSyncID})
	if err != nil {
		t.Fatal(err)
	}
	if len(epochs) != 1 {
		t.Fatalf("expected exactly one circle in the result, got %d", len(epochs))
	}
	if got := epochs[knownSyncID]; got.Meta != 1 {
		t.Fatalf("expected the known circle's meta epoch to be 1, got %d", got.Meta)
	}
	if _, ok := epochs[unknownSyncID]; ok {
		t.Fatal("expected the unknown syncID to be omitted, not present with a zero value")
	}
}

// BatchGetItem rejects a request containing the same key twice with a
// ValidationException, failing the whole batch — so a repeated syncID has
// to collapse before the call, not blow up the request.
func TestLogStore_Peek_ToleratesRepeatedSyncIDs(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	founder := newAuthorityKey(t)
	syncID := testsupport.UniqueSyncID(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)
	if _, err := store.Append(ctx, syncID, logstore.NamespaceMeta, "m-1", []byte("m"), 1, token); err != nil {
		t.Fatal(err)
	}

	epochs, err := store.Peek(ctx, []string{syncID, syncID, syncID})
	if err != nil {
		t.Fatalf("a repeated syncID must not fail the batch: %v", err)
	}
	if len(epochs) != 1 {
		t.Fatalf("expected one circle in the result, got %d", len(epochs))
	}
	if got := epochs[syncID]; got.Meta != 1 {
		t.Fatalf("expected meta epoch 1, got %d", got.Meta)
	}
}

func TestLogStore_Peek_EmptyInputReturnsEmptyResult(t *testing.T) {
	store := testsupport.NewLogStore(t)

	epochs, err := store.Peek(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(epochs) != 0 {
		t.Fatalf("expected an empty result for no syncIDs, got %d entries", len(epochs))
	}
}

// The bug this whole path exists to fix: before ChangeAuthority the
// authority set was written once at Bootstrap and never again, so a
// promoted admin's Rotate was rejected forever and the founder could
// never be replaced.
func TestLogStore_ChangeAuthority_AddedKeyCanThenRotate(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	promoted := newAuthorityKey(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)

	// Before the promotion, the promotee is nobody.
	rejectedHash := hashToken(t, newToken(t))
	_, err := store.Rotate(ctx, syncID, "rotate-early", []byte("payload"), 1, token, rejectedHash, promoted.publicKeyHex, promoted.sign(syncID, "rotate-early", rejectedHash))
	if !errors.Is(err, logstore.ErrAuthorityNotRecognized) {
		t.Fatalf("expected an unpromoted key to be rejected, got %v", err)
	}

	grant(t, store, syncID, "promote-1", founder, promoted, token)

	newTokenValue := newToken(t)
	newHash := hashToken(t, newTokenValue)
	commit, err := store.Rotate(ctx, syncID, "rotate-1", []byte("key_rotation payload"), 1, token, newHash, promoted.publicKeyHex, promoted.sign(syncID, "rotate-1", newHash))
	if err != nil {
		t.Fatalf("a promoted admin must be able to rotate: %v", err)
	}
	if commit.Epoch != 2 {
		t.Fatalf("expected the rotation at meta epoch 2 (behind the promotion's own entry), got %d", commit.Epoch)
	}
	if _, err := store.Append(ctx, syncID, logstore.NamespaceContent, "post-1", []byte("c"), 2, newTokenValue); err != nil {
		t.Fatalf("expected the promoted admin's new write token to work: %v", err)
	}
}

func TestLogStore_ChangeAuthority_AppendsItsEntryInTheSameTransaction(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	promoted := newAuthorityKey(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)

	commit, err := store.ChangeAuthority(ctx, authorityChange(founder, syncID, "promote-1", logstore.AuthorityAdd, promoted.publicKeyHex, token))
	if err != nil {
		t.Fatal(err)
	}
	if commit.Epoch != 1 {
		t.Fatalf("expected the promotion to land as meta's first entry, got %d", commit.Epoch)
	}

	metaRead, err := store.Read(ctx, syncID, logstore.NamespaceMeta, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(metaRead.Entries) != 1 || string(metaRead.Entries[0].EncryptedMeta) != "role_change payload" {
		t.Fatalf("expected the promotion's own entry readable back from meta, got %+v", metaRead.Entries)
	}
}

func TestLogStore_ChangeAuthority_RemovedKeyCanNoLongerRotate(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	promoted := newAuthorityKey(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)
	grant(t, store, syncID, "promote-1", founder, promoted, token)

	if _, err := store.ChangeAuthority(ctx, authorityChange(founder, syncID, "demote-1", logstore.AuthorityRemove, promoted.publicKeyHex, token)); err != nil {
		t.Fatal(err)
	}

	newHash := hashToken(t, newToken(t))
	_, err := store.Rotate(ctx, syncID, "rotate-1", []byte("payload"), 1, token, newHash, promoted.publicKeyHex, promoted.sign(syncID, "rotate-1", newHash))
	if !errors.Is(err, logstore.ErrAuthorityNotRecognized) {
		t.Fatalf("expected a demoted admin's rotate to be rejected, got %v", err)
	}
	// A demotion that left relay powers behind would be worse than no
	// demotion at all — the founder must still be able to rotate.
	if _, err := store.Rotate(ctx, syncID, "rotate-2", []byte("payload"), 1, token, newHash, founder.publicKeyHex, founder.sign(syncID, "rotate-2", newHash)); err != nil {
		t.Fatalf("the founder must still hold authority after demoting someone else: %v", err)
	}
}

func TestLogStore_ChangeAuthority_RejectsASignerOutsideTheSet(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	impostor := newAuthorityKey(t)
	accomplice := newAuthorityKey(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)

	_, err := store.ChangeAuthority(ctx, authorityChange(impostor, syncID, "promote-1", logstore.AuthorityAdd, accomplice.publicKeyHex, token))
	if !errors.Is(err, logstore.ErrAuthorityNotRecognized) {
		t.Fatalf("expected ErrAuthorityNotRecognized for a non-authority signer, got %v", err)
	}

	newHash := hashToken(t, newToken(t))
	if _, err := store.Rotate(ctx, syncID, "rotate-1", []byte("payload"), 1, token, newHash, accomplice.publicKeyHex, accomplice.sign(syncID, "rotate-1", newHash)); !errors.Is(err, logstore.ErrAuthorityNotRecognized) {
		t.Fatalf("a rejected promotion must not have added the key anyway, got %v", err)
	}
}

// The signature covers the action, so authorizing a promotion can't be
// turned into the demotion of the same person by editing one field.
func TestLogStore_ChangeAuthority_SignatureDoesNotCarryAcrossActions(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	promoted := newAuthorityKey(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)
	grant(t, store, syncID, "promote-1", founder, promoted, token)

	change := authorityChange(founder, syncID, "demote-1", logstore.AuthorityAdd, promoted.publicKeyHex, token)
	change.Action = logstore.AuthorityRemove
	_, err := store.ChangeAuthority(ctx, change)
	if !errors.Is(err, logstore.ErrInvalidSignature) {
		t.Fatalf("expected an add signature to be useless for a remove, got %v", err)
	}
}

// ...nor across circles, which is what binding the message to syncID buys.
func TestLogStore_ChangeAuthority_SignatureDoesNotCarryAcrossCircles(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	founder := newAuthorityKey(t)
	promoted := newAuthorityKey(t)

	tokenA := newToken(t)
	syncA := testsupport.UniqueSyncID(t) + "-a"
	bootstrap(t, store, syncA, founder, tokenA)
	tokenB := newToken(t)
	syncB := testsupport.UniqueSyncID(t) + "-b"
	bootstrap(t, store, syncB, founder, tokenB)

	change := authorityChange(founder, syncA, "promote-1", logstore.AuthorityAdd, promoted.publicKeyHex, tokenB)
	change.SyncID = syncB
	_, err := store.ChangeAuthority(ctx, change)
	if !errors.Is(err, logstore.ErrInvalidSignature) {
		t.Fatalf("expected a signature bound to another circle to be rejected, got %v", err)
	}
}

// Leaving a circle removes your own key, so self-removal has to work —
// it just can't be the last one out.
func TestLogStore_ChangeAuthority_SignerMayRemoveTheirOwnKeyButNotTheLast(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	promoted := newAuthorityKey(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)

	_, err := store.ChangeAuthority(ctx, authorityChange(founder, syncID, "resign-early", logstore.AuthorityRemove, founder.publicKeyHex, token))
	if !errors.Is(err, logstore.ErrWouldEmptyAuthoritySet) {
		t.Fatalf("expected the sole authority's resignation to be refused, got %v", err)
	}

	// With a successor in place it goes through — this is the handover.
	grant(t, store, syncID, "promote-1", founder, promoted, token)
	if _, err := store.ChangeAuthority(ctx, authorityChange(founder, syncID, "resign-1", logstore.AuthorityRemove, founder.publicKeyHex, token)); err != nil {
		t.Fatalf("a departing authority must be able to remove their own key: %v", err)
	}

	newHash := hashToken(t, newToken(t))
	if _, err := store.Rotate(ctx, syncID, "rotate-1", []byte("payload"), 1, token, newHash, founder.publicKeyHex, founder.sign(syncID, "rotate-1", newHash)); !errors.Is(err, logstore.ErrAuthorityNotRecognized) {
		t.Fatalf("a resigned authority must lose its powers, got %v", err)
	}
	if _, err := store.Rotate(ctx, syncID, "rotate-2", []byte("payload"), 1, token, newHash, promoted.publicKeyHex, promoted.sign(syncID, "rotate-2", newHash)); err != nil {
		t.Fatalf("the successor must still be able to govern: %v", err)
	}
}

// The other way to empty the set: demote your way down rather than
// resign. Both must hit the same floor.
func TestLogStore_ChangeAuthority_RefusesToDemoteDownToAnEmptySet(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	promoted := newAuthorityKey(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)
	grant(t, store, syncID, "promote-1", founder, promoted, token)

	// Two in the set, so demoting the founder is fine.
	if _, err := store.ChangeAuthority(ctx, authorityChange(promoted, syncID, "demote-1", logstore.AuthorityRemove, founder.publicKeyHex, token)); err != nil {
		t.Fatal(err)
	}
	// One left, so there is nowhere further down to go.
	_, err := store.ChangeAuthority(ctx, authorityChange(promoted, syncID, "demote-2", logstore.AuthorityRemove, promoted.publicKeyHex, token))
	if !errors.Is(err, logstore.ErrWouldEmptyAuthoritySet) {
		t.Fatalf("expected ErrWouldEmptyAuthoritySet, got %v", err)
	}

	newHash := hashToken(t, newToken(t))
	if _, err := store.Rotate(ctx, syncID, "rotate-1", []byte("payload"), 1, token, newHash, promoted.publicKeyHex, promoted.sign(syncID, "rotate-1", newHash)); err != nil {
		t.Fatalf("the circle must still be governable: %v", err)
	}
}

func TestLogStore_ChangeAuthority_RejectsAMalformedTargetKey(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)

	for name, target := range map[string]string{
		"not hex":    "zzzz",
		"wrong size": "aabbcc",
	} {
		_, err := store.ChangeAuthority(ctx, authorityChange(founder, syncID, "promote-"+name, logstore.AuthorityAdd, target, token))
		if !errors.Is(err, logstore.ErrInvalidAuthorityKey) {
			t.Fatalf("%s: expected ErrInvalidAuthorityKey, got %v", name, err)
		}
	}
}

func TestLogStore_ChangeAuthority_RejectsAnUnknownAction(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	promoted := newAuthorityKey(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)

	_, err := store.ChangeAuthority(ctx, authorityChange(founder, syncID, "promote-1", "replace", promoted.publicKeyHex, token))
	if !errors.Is(err, logstore.ErrInvalidAuthorityAction) {
		t.Fatalf("expected ErrInvalidAuthorityAction, got %v", err)
	}
}

// Authority alone isn't enough: the entry it appends is still an append,
// and every append is possession-gated.
func TestLogStore_ChangeAuthority_RejectsAStaleWriteToken(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	promoted := newAuthorityKey(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)

	_, err := store.ChangeAuthority(ctx, authorityChange(founder, syncID, "promote-1", logstore.AuthorityAdd, promoted.publicKeyHex, newToken(t)))
	if !errors.Is(err, logstore.ErrWriteTokenMismatch) {
		t.Fatalf("expected ErrWriteTokenMismatch, got %v", err)
	}
}

func TestLogStore_ChangeAuthority_RetryWithTheSameEntryIDIsIdempotent(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	promoted := newAuthorityKey(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)

	change := authorityChange(founder, syncID, "promote-1", logstore.AuthorityAdd, promoted.publicKeyHex, token)
	first, err := store.ChangeAuthority(ctx, change)
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.ChangeAuthority(ctx, change)
	if err != nil {
		t.Fatal(err)
	}
	if first.Epoch != second.Epoch {
		t.Fatalf("expected a retry to converge on epoch %d, got %d", first.Epoch, second.Epoch)
	}

	metaRead, err := store.Read(ctx, syncID, logstore.NamespaceMeta, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(metaRead.Entries) != 1 {
		t.Fatalf("expected the retry to append nothing, got %d meta entries", len(metaRead.Entries))
	}
}

// circleDeletion builds a fully-populated, correctly-signed
// CircleDeletion — same convention as authorityChange.
func circleDeletion(signer authorityKey, syncID, entryID, token string) logstore.CircleDeletion {
	deletion := logstore.CircleDeletion{
		SyncID:                   syncID,
		EntryID:                  entryID,
		EncryptedPayload:         []byte("circle_deleted payload"),
		KeyVersion:               1,
		WriteToken:               token,
		SignerAuthorityPublicKey: signer.publicKeyHex,
	}
	deletion.Signature = ed25519.Sign(signer.private, deletion.Message())
	return deletion
}

func TestLogStore_DeleteCircle_SweepsContentButKeepsMetaAndTheTombstone(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)

	if _, err := store.Append(ctx, syncID, logstore.NamespaceMeta, "member-1", []byte("member_added"), 1, token); err != nil {
		t.Fatal(err)
	}
	for _, entryID := range []string{"post-1", "post-2", "post-3"} {
		if _, err := store.Append(ctx, syncID, logstore.NamespaceContent, entryID, []byte("post"), 1, token); err != nil {
			t.Fatal(err)
		}
	}

	commit, err := store.DeleteCircle(ctx, circleDeletion(founder, syncID, "tombstone-1", token))
	if err != nil {
		t.Fatalf("deleting the circle failed: %v", err)
	}
	if commit.Epoch != 2 {
		t.Fatalf("expected the tombstone at meta epoch 2, behind member-1, got %d", commit.Epoch)
	}

	// Meta survives whole, or a device syncing from epoch 0 would have no
	// roster to verify the tombstone's author against.
	metaRead, err := store.Read(ctx, syncID, logstore.NamespaceMeta, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(metaRead.Entries) != 2 {
		t.Fatalf("expected meta to keep both its entries, got %d", len(metaRead.Entries))
	}
	if string(metaRead.Entries[1].EncryptedMeta) != "circle_deleted payload" {
		t.Fatalf("expected the tombstone last in meta, got %q", metaRead.Entries[1].EncryptedMeta)
	}

	contentRead, err := store.Read(ctx, syncID, logstore.NamespaceContent, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(contentRead.Entries) != 0 {
		t.Fatalf("expected every content entry swept, got %d", len(contentRead.Entries))
	}
}

func TestLogStore_DeleteCircle_RefusesEveryLaterWrite(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	promoted := newAuthorityKey(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)

	if _, err := store.DeleteCircle(ctx, circleDeletion(founder, syncID, "tombstone-1", token)); err != nil {
		t.Fatal(err)
	}

	if _, err := store.Append(ctx, syncID, logstore.NamespaceContent, "post-after", []byte("post"), 1, token); !errors.Is(err, logstore.ErrCircleDeleted) {
		t.Fatalf("expected a content append to be refused, got %v", err)
	}
	if _, err := store.Append(ctx, syncID, logstore.NamespaceMeta, "meta-after", []byte("meta"), 1, token); !errors.Is(err, logstore.ErrCircleDeleted) {
		t.Fatalf("expected a meta append to be refused, got %v", err)
	}

	newHash := hashToken(t, newToken(t))
	if _, err := store.Rotate(ctx, syncID, "rotate-after", []byte("k"), 1, token, newHash, founder.publicKeyHex, founder.sign(syncID, "rotate-after", newHash)); !errors.Is(err, logstore.ErrCircleDeleted) {
		t.Fatalf("expected a rotation to be refused, got %v", err)
	}
	if _, err := store.ChangeAuthority(ctx, authorityChange(founder, syncID, "promote-after", logstore.AuthorityAdd, promoted.publicKeyHex, token)); !errors.Is(err, logstore.ErrCircleDeleted) {
		t.Fatalf("expected an authority change to be refused, got %v", err)
	}
	if _, err := store.DeleteCircle(ctx, circleDeletion(founder, syncID, "tombstone-2", token)); !errors.Is(err, logstore.ErrCircleDeleted) {
		t.Fatalf("expected a second deletion to be refused, got %v", err)
	}
}

func TestLogStore_DeleteCircle_KeepsServingReads(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)

	if _, err := store.DeleteCircle(ctx, circleDeletion(founder, syncID, "tombstone-1", token)); err != nil {
		t.Fatal(err)
	}

	// A device that hasn't synced since finds the tombstone only if reads
	// still work — refusing them would leave it holding the circle forever.
	read, err := store.Read(ctx, syncID, logstore.NamespaceMeta, 0)
	if err != nil {
		t.Fatalf("reads must survive deletion: %v", err)
	}
	if len(read.Entries) != 1 {
		t.Fatalf("expected the tombstone readable, got %d entries", len(read.Entries))
	}
	epochs, err := store.Peek(ctx, []string{syncID})
	if err != nil {
		t.Fatal(err)
	}
	if epochs[syncID].Meta != 1 {
		t.Fatalf("expected Peek to report the tombstone's epoch, got %+v", epochs[syncID])
	}
}

func TestLogStore_DeleteCircle_RejectsASignerOutsideTheSet(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	outsider := newAuthorityKey(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)

	if _, err := store.DeleteCircle(ctx, circleDeletion(outsider, syncID, "tombstone-1", token)); !errors.Is(err, logstore.ErrAuthorityNotRecognized) {
		t.Fatalf("expected a non-authority to be refused, got %v", err)
	}
	if _, err := store.Append(ctx, syncID, logstore.NamespaceContent, "post-1", []byte("post"), 1, token); err != nil {
		t.Fatalf("a refused deletion must leave the circle writable: %v", err)
	}
}

func TestLogStore_DeleteCircle_SignatureDoesNotCarryAcrossCircles(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	founder := newAuthorityKey(t)
	token := newToken(t)
	target := testsupport.UniqueSyncID(t)
	other := testsupport.UniqueSyncID(t)
	bootstrap(t, store, target, founder, token)
	bootstrap(t, store, other, founder, token)

	deletion := circleDeletion(founder, other, "tombstone-1", token)
	deletion.SyncID = target
	if _, err := store.DeleteCircle(ctx, deletion); !errors.Is(err, logstore.ErrInvalidSignature) {
		t.Fatalf("expected a signature for another circle to be refused, got %v", err)
	}
}

func TestLogStore_DeleteCircle_RetryWithTheSameEntryIDIsIdempotent(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)

	first, err := store.DeleteCircle(ctx, circleDeletion(founder, syncID, "tombstone-1", token))
	if err != nil {
		t.Fatal(err)
	}
	// The same entryID is a retry of a call whose response was lost, not a
	// second deletion — it re-runs the sweep and returns the original commit.
	second, err := store.DeleteCircle(ctx, circleDeletion(founder, syncID, "tombstone-1", token))
	if err != nil {
		t.Fatalf("a retry must converge rather than fail: %v", err)
	}
	if first != second {
		t.Fatalf("expected the retry to return the original commit, got %+v then %+v", first, second)
	}
}

// More entries than one BatchWriteItem can carry (25), so the sweep has to
// chunk — the boundary a single-batch test would never reach.
func TestLogStore_DeleteCircle_SweepsPastOneBatch(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)

	const entries = 30
	for i := range entries {
		if _, err := store.Append(ctx, syncID, logstore.NamespaceContent, fmt.Sprintf("post-%d", i), []byte("post"), 1, token); err != nil {
			t.Fatal(err)
		}
	}

	if _, err := store.DeleteCircle(ctx, circleDeletion(founder, syncID, "tombstone-1", token)); err != nil {
		t.Fatal(err)
	}

	read, err := store.Read(ctx, syncID, logstore.NamespaceContent, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(read.Entries) != 0 {
		t.Fatalf("expected all %d content entries swept across batches, got %d left", entries, len(read.Entries))
	}
}

// Meta is stamped for expiry rather than deleted: still readable now, so a
// device syncing from epoch 0 can rebuild a roster and verify the
// tombstone, but no longer stored forever.
func TestLogStore_DeleteCircle_StampsMetaForExpiryWithoutDeletingIt(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)

	if _, err := store.Append(ctx, syncID, logstore.NamespaceMeta, "member-1", []byte("member_added"), 1, token); err != nil {
		t.Fatal(err)
	}
	if _, err := store.DeleteCircle(ctx, circleDeletion(founder, syncID, "tombstone-1", token)); err != nil {
		t.Fatal(err)
	}

	read, err := store.Read(ctx, syncID, logstore.NamespaceMeta, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(read.Entries) != 2 {
		t.Fatalf("expected meta still readable, got %d entries", len(read.Entries))
	}

	// Every meta row, tombstone included, carries a future expiry.
	for _, epoch := range []int64{1, 2} {
		// Built here rather than reached for: entrySK is unexported, and
		// this asserts on the physical row the store wrote.
		out, err := testsupport.RawItem(t, syncID, fmt.Sprintf("meta#%012d", epoch))
		if err != nil {
			t.Fatal(err)
		}
		attr, ok := out["expiresAt"].(*ddbtypes.AttributeValueMemberN)
		if !ok {
			t.Fatalf("expected meta epoch %d stamped with expiresAt, got %+v", epoch, out)
		}
		expiresAt, err := strconv.ParseInt(attr.Value, 10, 64)
		if err != nil {
			t.Fatal(err)
		}
		if expiresAt <= time.Now().Unix() {
			t.Fatalf("expected meta epoch %d to expire in the future, got %d", epoch, expiresAt)
		}
	}
}

// A circle nobody ever posted to still deletes cleanly — and without
// querying a namespace the counter already says is empty.
func TestLogStore_DeleteCircle_WithNoContentAtAll(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)

	if _, err := store.DeleteCircle(ctx, circleDeletion(founder, syncID, "tombstone-1", token)); err != nil {
		t.Fatalf("deleting an empty circle failed: %v", err)
	}

	read, err := store.Read(ctx, syncID, logstore.NamespaceMeta, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(read.Entries) != 1 {
		t.Fatalf("expected just the tombstone, got %d entries", len(read.Entries))
	}
	if _, err := store.Append(ctx, syncID, logstore.NamespaceContent, "post-1", []byte("post"), 1, token); !errors.Is(err, logstore.ErrCircleDeleted) {
		t.Fatalf("expected the circle closed to writes, got %v", err)
	}
}
