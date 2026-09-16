package dynamodb_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"testing"
	"time"

	ddbtypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"circle-relay/internal/synclog"
	"circle-relay/internal/testsupport"
)

func hashToken(t *testing.T, tokenHex string) string {
	t.Helper()
	hash, err := synclog.WriteTokenHash(tokenHex)
	if err != nil {
		t.Fatalf("test token isn't valid hex: %v", err)
	}
	return hash
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
	return ed25519.Sign(k.private, synclog.RotateMessage(syncID, entryID, newWriteTokenHash))
}

// authorityChange builds a fully-populated, correctly-signed
// AuthorityChange — tests that want a *wrong* one edit a field after the
// signature is made, which is exactly the tamper each is checking for.
func authorityChange(signer authorityKey, syncID, entryID string, action synclog.AuthorityAction, target, token string) synclog.AuthorityChange {
	change := synclog.AuthorityChange{
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
func grant(t *testing.T, store synclog.LogStore, syncID, entryID string, signer, target authorityKey, token string) {
	t.Helper()
	if _, err := store.ChangeAuthority(context.Background(), authorityChange(signer, syncID, entryID, synclog.AuthorityAdd, target.publicKeyHex, token)); err != nil {
		t.Fatalf("granting authority failed: %v", err)
	}
}

func bootstrap(t *testing.T, store synclog.LogStore, syncID string, founder authorityKey, token string) {
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
	if !errors.Is(err, synclog.ErrAlreadyExists) {
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

	first, err := store.Append(ctx, syncID, synclog.NamespaceMeta, "entry-1", []byte("ciphertext"), 1, token, "test-author-key")
	if err != nil {
		t.Fatal(err)
	}
	if first.Epoch != 1 {
		t.Fatalf("expected first entry to land at epoch 1, got %d", first.Epoch)
	}

	second, err := store.Append(ctx, syncID, synclog.NamespaceMeta, "entry-2", []byte("ciphertext"), 1, token, "test-author-key")
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

	_, err := store.Append(ctx, syncID, synclog.NamespaceMeta, "entry-1", []byte("ciphertext"), 1, "not-the-real-token-hex", "test-author-key")
	if !errors.Is(err, synclog.ErrWriteTokenMismatch) {
		t.Fatalf("expected ErrWriteTokenMismatch, got %v", err)
	}

	// A wrong token must never burn an epoch — the first entry with the
	// *correct* token still lands at epoch 1, not 2.
	commit, err := store.Append(ctx, syncID, synclog.NamespaceMeta, "entry-2", []byte("ciphertext"), 1, token, "test-author-key")
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

	_, err := store.Append(ctx, testsupport.UniqueSyncID(t), synclog.NamespaceMeta, "entry-1", []byte("ciphertext"), 1, newToken(t), "test-author-key")
	if !errors.Is(err, synclog.ErrCircleNotFound) {
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

	metaCommit, err := store.Append(ctx, syncID, synclog.NamespaceMeta, "meta-1", []byte("m"), 1, token, "test-author-key")
	if err != nil {
		t.Fatal(err)
	}
	content1, err := store.Append(ctx, syncID, synclog.NamespaceContent, "content-1", []byte("c1"), 1, token, "test-author-key")
	if err != nil {
		t.Fatal(err)
	}
	content2, err := store.Append(ctx, syncID, synclog.NamespaceContent, "content-2", []byte("c2"), 1, token, "test-author-key")
	if err != nil {
		t.Fatal(err)
	}

	if metaCommit.Epoch != 1 {
		t.Fatalf("expected meta's own first entry at epoch 1, got %d", metaCommit.Epoch)
	}
	if content1.Epoch != 1 || content2.Epoch != 2 {
		t.Fatalf("expected content's own independent sequence 1,2 — got %d,%d", content1.Epoch, content2.Epoch)
	}

	metaRead, err := store.Read(ctx, syncID, synclog.NamespaceMeta, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(metaRead.Entries) != 1 {
		t.Fatalf("expected exactly the one meta entry when reading meta, got %d (content must not leak into meta)", len(metaRead.Entries))
	}

	contentRead, err := store.Read(ctx, syncID, synclog.NamespaceContent, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(contentRead.Entries) != 2 {
		t.Fatalf("expected exactly the two content entries when reading content, got %d (meta must not leak into content)", len(contentRead.Entries))
	}
}

func TestLogStore_Append_RecordsAuthorIdentityPublicKeyAndReadReturnsIt(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)

	if _, err := store.Append(ctx, syncID, synclog.NamespaceContent, "post-1", []byte("ciphertext"), 1, token, "declared-author-key"); err != nil {
		t.Fatal(err)
	}

	read, err := store.Read(ctx, syncID, synclog.NamespaceContent, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(read.Entries) != 1 {
		t.Fatalf("expected exactly one entry, got %d", len(read.Entries))
	}
	if got := read.Entries[0].AuthorIdentityPublicKey; got != "declared-author-key" {
		t.Fatalf("expected the declared author key to round-trip, got %q", got)
	}
}

func TestLogStore_Rotate_LeavesAuthorIdentityPublicKeyEmpty(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)

	newHash := hashToken(t, newToken(t))
	if _, err := store.Rotate(ctx, syncID, "rotation-1", []byte("ciphertext"), 1, hashToken(t, token), newHash, founder.publicKeyHex); err != nil {
		t.Fatal(err)
	}

	read, err := store.Read(ctx, syncID, synclog.NamespaceMeta, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(read.Entries) != 1 {
		t.Fatalf("expected exactly one entry, got %d", len(read.Entries))
	}
	// A key rotation isn't authored content in the account-deletion sense
	// this field exists for — it must land empty, not carry the authority
	// key that signed it.
	if got := read.Entries[0].AuthorIdentityPublicKey; got != "" {
		t.Fatalf("expected AuthorIdentityPublicKey to be empty on a rotation entry, got %q", got)
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
	results := make([]synclog.CommitResult, concurrency)
	errs := make([]error, concurrency)

	var wg sync.WaitGroup
	wg.Add(concurrency)
	for i := range concurrency {
		go func() {
			defer wg.Done()
			results[i], errs[i] = store.Append(ctx, syncID, synclog.NamespaceContent, "post-1", []byte("ciphertext"), 1, token, "test-author-key")
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

	commit, err := store.Rotate(ctx, syncID, "rotate-1", []byte("key_rotation payload"), 1, hashToken(t, oldToken), newHash, founder.publicKeyHex)
	if err != nil {
		t.Fatal(err)
	}
	if commit.Epoch != 1 {
		t.Fatalf("expected the rotation to land as meta's first entry (epoch 1), got %d", commit.Epoch)
	}

	// The old token must no longer work...
	if _, err := store.Append(ctx, syncID, synclog.NamespaceContent, "post-with-old-token", []byte("c"), 1, oldToken, "test-author-key"); !errors.Is(err, synclog.ErrWriteTokenMismatch) {
		t.Fatalf("expected old write token to be rejected after rotation, got %v", err)
	}
	// ...and the new one must.
	if _, err := store.Append(ctx, syncID, synclog.NamespaceContent, "post-with-new-token", []byte("c"), 1, newTokenValue, "test-author-key"); err != nil {
		t.Fatalf("expected new write token to work after rotation: %v", err)
	}

	metaRead, err := store.Read(ctx, syncID, synclog.NamespaceMeta, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(metaRead.Entries) != 1 || string(metaRead.Entries[0].EncryptedMeta) != "key_rotation payload" {
		t.Fatalf("expected the rotation's own entry to be readable back from meta, got %+v", metaRead.Entries)
	}
}

func TestLogStore_Rotate_RejectsAKeyNotInTheAuthoritySet(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	impostor := newAuthorityKey(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)

	newHash := hashToken(t, newToken(t))

	_, err := store.Rotate(ctx, syncID, "rotate-1", []byte("payload"), 1, hashToken(t, token), newHash, impostor.publicKeyHex)
	if !errors.Is(err, synclog.ErrAuthorityNotRecognized) {
		t.Fatalf("expected ErrAuthorityNotRecognized for an unrecognized authority key, got %v", err)
	}

	// Nothing should have moved: the original token still works.
	if _, err := store.Append(ctx, syncID, synclog.NamespaceContent, "post-1", []byte("c"), 1, token, "test-author-key"); err != nil {
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

	_, err := store.Rotate(ctx, syncID, "rotate-1", []byte("payload"), 1, hashToken(t, newToken(t)), newHash, founder.publicKeyHex)
	if !errors.Is(err, synclog.ErrWriteTokenMismatch) {
		t.Fatalf("expected ErrWriteTokenMismatch for a stale currentWriteTokenHash, got %v", err)
	}
}

func TestLogStore_Read_UnbootstrappedSyncIDReadsAsEmptyNotError(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)

	result, err := store.Read(ctx, testsupport.UniqueSyncID(t), synclog.NamespaceMeta, 0)
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
		if _, err := store.Append(ctx, syncID, synclog.NamespaceContent, fmt.Sprintf("post-%d", i), []byte("ciphertext"), 1, token, "test-author-key"); err != nil {
			t.Fatalf("append %d failed: %v", i, err)
		}
	}

	first, err := store.Read(ctx, syncID, synclog.NamespaceContent, 0)
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

	second, err := store.Read(ctx, syncID, synclog.NamespaceContent, lastInFirstPage)
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
	if _, err := store.Append(ctx, syncIDA, synclog.NamespaceMeta, "a-meta-1", []byte("m"), 1, tokenA, "test-author-key"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Append(ctx, syncIDA, synclog.NamespaceContent, "a-content-1", []byte("c"), 1, tokenA, "test-author-key"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Append(ctx, syncIDA, synclog.NamespaceContent, "a-content-2", []byte("c"), 1, tokenA, "test-author-key"); err != nil {
		t.Fatal(err)
	}

	syncIDB := testsupport.UniqueSyncID(t)
	tokenB := newToken(t)
	bootstrap(t, store, syncIDB, founder, tokenB)
	if _, err := store.Append(ctx, syncIDB, synclog.NamespaceMeta, "b-meta-1", []byte("m"), 1, tokenB, "test-author-key"); err != nil {
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
	if _, err := store.Append(ctx, knownSyncID, synclog.NamespaceMeta, "m-1", []byte("m"), 1, token, "test-author-key"); err != nil {
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
	if _, err := store.Append(ctx, syncID, synclog.NamespaceMeta, "m-1", []byte("m"), 1, token, "test-author-key"); err != nil {
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
	_, err := store.Rotate(ctx, syncID, "rotate-early", []byte("payload"), 1, hashToken(t, token), rejectedHash, promoted.publicKeyHex)
	if !errors.Is(err, synclog.ErrAuthorityNotRecognized) {
		t.Fatalf("expected an unpromoted key to be rejected, got %v", err)
	}

	grant(t, store, syncID, "promote-1", founder, promoted, token)

	newTokenValue := newToken(t)
	newHash := hashToken(t, newTokenValue)
	commit, err := store.Rotate(ctx, syncID, "rotate-1", []byte("key_rotation payload"), 1, hashToken(t, token), newHash, promoted.publicKeyHex)
	if err != nil {
		t.Fatalf("a promoted admin must be able to rotate: %v", err)
	}
	if commit.Epoch != 2 {
		t.Fatalf("expected the rotation at meta epoch 2 (behind the promotion's own entry), got %d", commit.Epoch)
	}
	if _, err := store.Append(ctx, syncID, synclog.NamespaceContent, "post-1", []byte("c"), 2, newTokenValue, "test-author-key"); err != nil {
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

	commit, err := store.ChangeAuthority(ctx, authorityChange(founder, syncID, "promote-1", synclog.AuthorityAdd, promoted.publicKeyHex, token))
	if err != nil {
		t.Fatal(err)
	}
	if commit.Epoch != 1 {
		t.Fatalf("expected the promotion to land as meta's first entry, got %d", commit.Epoch)
	}

	metaRead, err := store.Read(ctx, syncID, synclog.NamespaceMeta, 0)
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

	if _, err := store.ChangeAuthority(ctx, authorityChange(founder, syncID, "demote-1", synclog.AuthorityRemove, promoted.publicKeyHex, token)); err != nil {
		t.Fatal(err)
	}

	newHash := hashToken(t, newToken(t))
	_, err := store.Rotate(ctx, syncID, "rotate-1", []byte("payload"), 1, hashToken(t, token), newHash, promoted.publicKeyHex)
	if !errors.Is(err, synclog.ErrAuthorityNotRecognized) {
		t.Fatalf("expected a demoted admin's rotate to be rejected, got %v", err)
	}
	// A demotion that left relay powers behind would be worse than no
	// demotion at all — the founder must still be able to rotate.
	if _, err := store.Rotate(ctx, syncID, "rotate-2", []byte("payload"), 1, hashToken(t, token), newHash, founder.publicKeyHex); err != nil {
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

	_, err := store.ChangeAuthority(ctx, authorityChange(impostor, syncID, "promote-1", synclog.AuthorityAdd, accomplice.publicKeyHex, token))
	if !errors.Is(err, synclog.ErrAuthorityNotRecognized) {
		t.Fatalf("expected ErrAuthorityNotRecognized for a non-authority signer, got %v", err)
	}

	newHash := hashToken(t, newToken(t))
	if _, err := store.Rotate(ctx, syncID, "rotate-1", []byte("payload"), 1, hashToken(t, token), newHash, accomplice.publicKeyHex); !errors.Is(err, synclog.ErrAuthorityNotRecognized) {
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

	change := authorityChange(founder, syncID, "demote-1", synclog.AuthorityAdd, promoted.publicKeyHex, token)
	change.Action = synclog.AuthorityRemove
	_, err := store.ChangeAuthority(ctx, change)
	if !errors.Is(err, synclog.ErrInvalidSignature) {
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

	change := authorityChange(founder, syncA, "promote-1", synclog.AuthorityAdd, promoted.publicKeyHex, tokenB)
	change.SyncID = syncB
	_, err := store.ChangeAuthority(ctx, change)
	if !errors.Is(err, synclog.ErrInvalidSignature) {
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

	_, err := store.ChangeAuthority(ctx, authorityChange(founder, syncID, "resign-early", synclog.AuthorityRemove, founder.publicKeyHex, token))
	if !errors.Is(err, synclog.ErrWouldEmptyAuthoritySet) {
		t.Fatalf("expected the sole authority's resignation to be refused, got %v", err)
	}

	// With a successor in place it goes through — this is the handover.
	grant(t, store, syncID, "promote-1", founder, promoted, token)
	if _, err := store.ChangeAuthority(ctx, authorityChange(founder, syncID, "resign-1", synclog.AuthorityRemove, founder.publicKeyHex, token)); err != nil {
		t.Fatalf("a departing authority must be able to remove their own key: %v", err)
	}

	newHash := hashToken(t, newToken(t))
	if _, err := store.Rotate(ctx, syncID, "rotate-1", []byte("payload"), 1, hashToken(t, token), newHash, founder.publicKeyHex); !errors.Is(err, synclog.ErrAuthorityNotRecognized) {
		t.Fatalf("a resigned authority must lose its powers, got %v", err)
	}
	if _, err := store.Rotate(ctx, syncID, "rotate-2", []byte("payload"), 1, hashToken(t, token), newHash, promoted.publicKeyHex); err != nil {
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
	if _, err := store.ChangeAuthority(ctx, authorityChange(promoted, syncID, "demote-1", synclog.AuthorityRemove, founder.publicKeyHex, token)); err != nil {
		t.Fatal(err)
	}
	// One left, so there is nowhere further down to go.
	_, err := store.ChangeAuthority(ctx, authorityChange(promoted, syncID, "demote-2", synclog.AuthorityRemove, promoted.publicKeyHex, token))
	if !errors.Is(err, synclog.ErrWouldEmptyAuthoritySet) {
		t.Fatalf("expected ErrWouldEmptyAuthoritySet, got %v", err)
	}

	newHash := hashToken(t, newToken(t))
	if _, err := store.Rotate(ctx, syncID, "rotate-1", []byte("payload"), 1, hashToken(t, token), newHash, promoted.publicKeyHex); err != nil {
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
		_, err := store.ChangeAuthority(ctx, authorityChange(founder, syncID, "promote-"+name, synclog.AuthorityAdd, target, token))
		if !errors.Is(err, synclog.ErrInvalidAuthorityKey) {
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
	if !errors.Is(err, synclog.ErrInvalidAuthorityAction) {
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

	_, err := store.ChangeAuthority(ctx, authorityChange(founder, syncID, "promote-1", synclog.AuthorityAdd, promoted.publicKeyHex, newToken(t)))
	if !errors.Is(err, synclog.ErrWriteTokenMismatch) {
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

	change := authorityChange(founder, syncID, "promote-1", synclog.AuthorityAdd, promoted.publicKeyHex, token)
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

	metaRead, err := store.Read(ctx, syncID, synclog.NamespaceMeta, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(metaRead.Entries) != 1 {
		t.Fatalf("expected the retry to append nothing, got %d meta entries", len(metaRead.Entries))
	}
}

// circleDeletion builds a fully-populated, correctly-signed
// CircleDeletion — same convention as authorityChange.
func circleDeletion(signer authorityKey, syncID, entryID, token string) synclog.CircleDeletion {
	deletion := synclog.CircleDeletion{
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

	if _, err := store.Append(ctx, syncID, synclog.NamespaceMeta, "member-1", []byte("member_added"), 1, token, "test-author-key"); err != nil {
		t.Fatal(err)
	}
	for _, entryID := range []string{"post-1", "post-2", "post-3"} {
		if _, err := store.Append(ctx, syncID, synclog.NamespaceContent, entryID, []byte("post"), 1, token, "test-author-key"); err != nil {
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
	metaRead, err := store.Read(ctx, syncID, synclog.NamespaceMeta, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(metaRead.Entries) != 2 {
		t.Fatalf("expected meta to keep both its entries, got %d", len(metaRead.Entries))
	}
	if string(metaRead.Entries[1].EncryptedMeta) != "circle_deleted payload" {
		t.Fatalf("expected the tombstone last in meta, got %q", metaRead.Entries[1].EncryptedMeta)
	}

	contentRead, err := store.Read(ctx, syncID, synclog.NamespaceContent, 0)
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

	if _, err := store.Append(ctx, syncID, synclog.NamespaceContent, "post-after", []byte("post"), 1, token, "test-author-key"); !errors.Is(err, synclog.ErrCircleDeleted) {
		t.Fatalf("expected a content append to be refused, got %v", err)
	}
	if _, err := store.Append(ctx, syncID, synclog.NamespaceMeta, "meta-after", []byte("meta"), 1, token, "test-author-key"); !errors.Is(err, synclog.ErrCircleDeleted) {
		t.Fatalf("expected a meta append to be refused, got %v", err)
	}

	newHash := hashToken(t, newToken(t))
	if _, err := store.Rotate(ctx, syncID, "rotate-after", []byte("k"), 1, hashToken(t, token), newHash, founder.publicKeyHex); !errors.Is(err, synclog.ErrCircleDeleted) {
		t.Fatalf("expected a rotation to be refused, got %v", err)
	}
	if _, err := store.ChangeAuthority(ctx, authorityChange(founder, syncID, "promote-after", synclog.AuthorityAdd, promoted.publicKeyHex, token)); !errors.Is(err, synclog.ErrCircleDeleted) {
		t.Fatalf("expected an authority change to be refused, got %v", err)
	}
	if _, err := store.DeleteCircle(ctx, circleDeletion(founder, syncID, "tombstone-2", token)); !errors.Is(err, synclog.ErrCircleDeleted) {
		t.Fatalf("expected a second deletion to be refused, got %v", err)
	}
}

func TestLogStore_DeleteCircle_RefusesLaterVerification(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)

	if _, err := store.DeleteCircle(ctx, circleDeletion(founder, syncID, "tombstone-1", token)); err != nil {
		t.Fatal(err)
	}

	// A still-valid write token or authority signature must not keep
	// gating blob operations (upload targets, blob deletes) after the
	// circle they belong to is gone.
	if err := store.VerifyWriteToken(ctx, syncID, token); !errors.Is(err, synclog.ErrCircleDeleted) {
		t.Fatalf("expected VerifyWriteToken to refuse a deleted circle, got %v", err)
	}
	message := []byte("arbitrary-message")
	signature := ed25519.Sign(founder.private, message)
	if err := store.VerifyAuthoritySignature(ctx, syncID, founder.publicKeyHex, message, signature); !errors.Is(err, synclog.ErrCircleDeleted) {
		t.Fatalf("expected VerifyAuthoritySignature to refuse a deleted circle, got %v", err)
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
	read, err := store.Read(ctx, syncID, synclog.NamespaceMeta, 0)
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

	if _, err := store.DeleteCircle(ctx, circleDeletion(outsider, syncID, "tombstone-1", token)); !errors.Is(err, synclog.ErrAuthorityNotRecognized) {
		t.Fatalf("expected a non-authority to be refused, got %v", err)
	}
	if _, err := store.Append(ctx, syncID, synclog.NamespaceContent, "post-1", []byte("post"), 1, token, "test-author-key"); err != nil {
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
	if _, err := store.DeleteCircle(ctx, deletion); !errors.Is(err, synclog.ErrInvalidSignature) {
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
		if _, err := store.Append(ctx, syncID, synclog.NamespaceContent, fmt.Sprintf("post-%d", i), []byte("post"), 1, token, "test-author-key"); err != nil {
			t.Fatal(err)
		}
	}

	if _, err := store.DeleteCircle(ctx, circleDeletion(founder, syncID, "tombstone-1", token)); err != nil {
		t.Fatal(err)
	}

	read, err := store.Read(ctx, syncID, synclog.NamespaceContent, 0)
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

	if _, err := store.Append(ctx, syncID, synclog.NamespaceMeta, "member-1", []byte("member_added"), 1, token, "test-author-key"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.DeleteCircle(ctx, circleDeletion(founder, syncID, "tombstone-1", token)); err != nil {
		t.Fatal(err)
	}

	read, err := store.Read(ctx, syncID, synclog.NamespaceMeta, 0)
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

	read, err := store.Read(ctx, syncID, synclog.NamespaceMeta, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(read.Entries) != 1 {
		t.Fatalf("expected just the tombstone, got %d entries", len(read.Entries))
	}
	if _, err := store.Append(ctx, syncID, synclog.NamespaceContent, "post-1", []byte("post"), 1, token, "test-author-key"); !errors.Is(err, synclog.ErrCircleDeleted) {
		t.Fatalf("expected the circle closed to writes, got %v", err)
	}
}

// deleteEntry builds an EntryDeletion signed by author for entryID —
// tests that want a wrong signature edit AuthorSignature after.
func deleteEntry(author authorityKey, syncID, entryID, tombstoneEntryID, token string) synclog.EntryDeletion {
	deletion := synclog.EntryDeletion{
		SyncID:           syncID,
		TargetEntryID:    entryID,
		TombstoneEntryID: tombstoneEntryID,
		EncryptedPayload: []byte("post_delete payload"),
		KeyVersion:       1,
		WriteToken:       token,
	}
	deletion.AuthorSignature = ed25519.Sign(author.private, deletion.Message())
	return deletion
}

func TestLogStore_DeleteEntry_SucceedsViaAuthorSignature(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	author := newAuthorityKey(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)

	// Not a literal "post-1": the entryId-index GSI is global across the
	// whole shared test table, and other tests' posts already use that.
	postID := syncID + "-post-1"
	if _, err := store.Append(ctx, syncID, synclog.NamespaceContent, postID, []byte("caption"), 1, token, author.publicKeyHex); err != nil {
		t.Fatal(err)
	}

	commit, err := store.DeleteEntry(ctx, deleteEntry(author, syncID, postID, "tombstone-1", token))
	if err != nil {
		t.Fatal(err)
	}
	if commit.Epoch != 2 {
		t.Fatalf("expected the tombstone at epoch 2, got %d", commit.Epoch)
	}

	read, err := store.Read(ctx, syncID, synclog.NamespaceContent, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(read.Entries) != 2 {
		t.Fatalf("expected the post row to survive alongside the tombstone, got %d entries", len(read.Entries))
	}
	if len(read.Entries[0].EncryptedMeta) != 0 {
		t.Fatalf("expected the post's EncryptedMeta to be gone, got %q", read.Entries[0].EncryptedMeta)
	}

	item, err := testsupport.RawItem(t, syncID, "content#000000000001")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := item["deletedAt"]; !ok {
		t.Fatal("expected deletedAt to be set on the stripped row")
	}
	if who, _ := item["deletedBy"].(*ddbtypes.AttributeValueMemberS); who == nil || who.Value != author.publicKeyHex {
		t.Fatalf("expected deletedBy to be the author's key, got %+v", item["deletedBy"])
	}
}

func TestLogStore_DeleteEntry_SucceedsViaAuthoritySignature(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	author := newAuthorityKey(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)

	postID := syncID + "-post-1"
	if _, err := store.Append(ctx, syncID, synclog.NamespaceContent, postID, []byte("caption"), 1, token, author.publicKeyHex); err != nil {
		t.Fatal(err)
	}

	deletion := synclog.EntryDeletion{
		SyncID:           syncID,
		TargetEntryID:    postID,
		TombstoneEntryID: "tombstone-1",
		EncryptedPayload: []byte("post_delete payload"),
		KeyVersion:       1,
		WriteToken:       token,
		// No AuthorSignature — an admin deleting someone else's post.
		AuthorityPublicKey: founder.publicKeyHex,
	}
	deletion.AuthoritySignature = ed25519.Sign(founder.private, deletion.Message())

	if _, err := store.DeleteEntry(ctx, deletion); err != nil {
		t.Fatal(err)
	}
}

func TestLogStore_DeleteEntry_RejectsWrongSignature(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	author := newAuthorityKey(t)
	impostor := newAuthorityKey(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)

	postID := syncID + "-post-1"
	if _, err := store.Append(ctx, syncID, synclog.NamespaceContent, postID, []byte("caption"), 1, token, author.publicKeyHex); err != nil {
		t.Fatal(err)
	}

	if _, err := store.DeleteEntry(ctx, deleteEntry(impostor, syncID, postID, "tombstone-1", token)); !errors.Is(err, synclog.ErrEntryNotAuthorized) {
		t.Fatalf("expected ErrEntryNotAuthorized, got %v", err)
	}
}

func TestLogStore_DeleteEntry_RejectsUnknownTargetEntryID(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)

	if _, err := store.DeleteEntry(ctx, deleteEntry(founder, syncID, "no-such-post", "tombstone-1", token)); !errors.Is(err, synclog.ErrEntryNotFound) {
		t.Fatalf("expected ErrEntryNotFound, got %v", err)
	}
}

func TestLogStore_DeleteEntry_RejectsAMetaNamespaceTargetEntryID(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)

	// The entryId-index GSI spans both namespaces, so a meta entry's id is
	// findable the same way a content entry's is. DeleteEntry must still
	// refuse it rather than strip whatever content row happens to sit at
	// that resolved epoch.
	metaEntryID := syncID + "-meta-entry"
	if _, err := store.Append(ctx, syncID, synclog.NamespaceMeta, metaEntryID, []byte("meta"), 1, token, founder.publicKeyHex); err != nil {
		t.Fatal(err)
	}

	if _, err := store.DeleteEntry(ctx, deleteEntry(founder, syncID, metaEntryID, "tombstone-1", token)); !errors.Is(err, synclog.ErrEntryNotFound) {
		t.Fatalf("expected ErrEntryNotFound for a meta-namespace target, got %v", err)
	}
}

func TestLogStore_DeleteEntry_RetryWithTheSameTombstoneEntryIDIsIdempotent(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	author := newAuthorityKey(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)

	postID := syncID + "-post-1"
	if _, err := store.Append(ctx, syncID, synclog.NamespaceContent, postID, []byte("caption"), 1, token, author.publicKeyHex); err != nil {
		t.Fatal(err)
	}

	first, err := store.DeleteEntry(ctx, deleteEntry(author, syncID, postID, "tombstone-1", token))
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.DeleteEntry(ctx, deleteEntry(author, syncID, postID, "tombstone-1", token))
	if err != nil {
		t.Fatalf("a retry must converge rather than fail: %v", err)
	}
	if first != second {
		t.Fatalf("expected the retry to return the original commit, got %+v then %+v", first, second)
	}
}

// authorContentDeletion builds an AuthorContentDeletion signed by author —
// tombstoneEntryID "" means strip-only mode, which also sends no token.
func authorContentDeletion(author authorityKey, syncID, tombstoneEntryID, token string) synclog.AuthorContentDeletion {
	deletion := synclog.AuthorContentDeletion{
		SyncID:                  syncID,
		AuthorIdentityPublicKey: author.publicKeyHex,
		TombstoneEntryID:        tombstoneEntryID,
	}
	if tombstoneEntryID != "" {
		deletion.EncryptedPayload = []byte("account_deleted payload")
		deletion.KeyVersion = 1
		deletion.WriteToken = token
	}
	deletion.AuthorSignature = ed25519.Sign(author.private, deletion.Message())
	return deletion
}

func TestLogStore_DeleteAuthorContent_StripsTheAuthorsRowsAndAppendsTheTombstone(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	author := newAuthorityKey(t)
	other := newAuthorityKey(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)

	for i, id := range []string{"-a1", "-a2", "-a3"} {
		if _, err := store.Append(ctx, syncID, synclog.NamespaceContent, syncID+id, []byte(fmt.Sprintf("author content %d", i)), 1, token, author.publicKeyHex); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.Append(ctx, syncID, synclog.NamespaceContent, syncID+"-b1", []byte("other content"), 1, token, other.publicKeyHex); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Append(ctx, syncID, synclog.NamespaceMeta, syncID+"-m1", []byte("member_added"), 1, token, author.publicKeyHex); err != nil {
		t.Fatal(err)
	}

	result, err := store.DeleteAuthorContent(ctx, authorContentDeletion(author, syncID, syncID+"-tomb", token))
	if err != nil {
		t.Fatal(err)
	}
	if len(result.StrippedEntryIDs) != 3 {
		t.Fatalf("expected 3 stripped entries, got %v", result.StrippedEntryIDs)
	}
	// The existing member_added is meta epoch 1; the tombstone lands right
	// after it, in meta — not content, even though what it strips is
	// content — since it also carries the roster removal every client's
	// account-deletion path folds into it, and meta is what's synced
	// eagerly and in full.
	if result.Epoch != 2 {
		t.Fatalf("expected the tombstone at meta epoch 2, got %d", result.Epoch)
	}

	read, err := store.Read(ctx, syncID, synclog.NamespaceContent, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(read.Entries) != 4 {
		t.Fatalf("expected the 4 content rows to survive, tombstone excluded, got %d", len(read.Entries))
	}
	for _, entry := range read.Entries[:3] {
		if len(entry.EncryptedMeta) != 0 || entry.DeletedAt == 0 {
			t.Fatalf("expected the author's rows stripped and stamped, got %+v", entry)
		}
	}
	if len(read.Entries[3].EncryptedMeta) == 0 {
		t.Fatal("expected the other member's row untouched")
	}

	meta, err := store.Read(ctx, syncID, synclog.NamespaceMeta, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(meta.Entries) != 2 || len(meta.Entries[0].EncryptedMeta) == 0 {
		t.Fatal("expected the author's original meta entry untouched")
	}
	if len(meta.Entries[1].EncryptedMeta) == 0 {
		t.Fatal("expected the tombstone itself intact")
	}
}

func TestLogStore_DeleteAuthorContent_StripOnlyModeAppendsNothing(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	author := newAuthorityKey(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)

	if _, err := store.Append(ctx, syncID, synclog.NamespaceContent, syncID+"-a1", []byte("caption"), 1, token, author.publicKeyHex); err != nil {
		t.Fatal(err)
	}

	// No tombstone and no write token — a departed member's erase.
	result, err := store.DeleteAuthorContent(ctx, authorContentDeletion(author, syncID, "", ""))
	if err != nil {
		t.Fatal(err)
	}
	if len(result.StrippedEntryIDs) != 1 || result.Epoch != 0 {
		t.Fatalf("expected one strip and no tombstone commit, got %+v", result)
	}

	read, err := store.Read(ctx, syncID, synclog.NamespaceContent, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(read.Entries) != 1 || len(read.Entries[0].EncryptedMeta) != 0 {
		t.Fatalf("expected just the stripped row, got %d entries", len(read.Entries))
	}
}

func TestLogStore_DeleteAuthorContent_RejectsAWrongSignature(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	author := newAuthorityKey(t)
	impostor := newAuthorityKey(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)

	if _, err := store.Append(ctx, syncID, synclog.NamespaceContent, syncID+"-a1", []byte("caption"), 1, token, author.publicKeyHex); err != nil {
		t.Fatal(err)
	}

	// The impostor claims the author's key but can't sign for it.
	deletion := authorContentDeletion(impostor, syncID, "", "")
	deletion.AuthorIdentityPublicKey = author.publicKeyHex
	if _, err := store.DeleteAuthorContent(ctx, deletion); !errors.Is(err, synclog.ErrEntryNotAuthorized) {
		t.Fatalf("expected ErrEntryNotAuthorized, got %v", err)
	}

	read, err := store.Read(ctx, syncID, synclog.NamespaceContent, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(read.Entries[0].EncryptedMeta) == 0 {
		t.Fatal("expected the row to survive a refused erase")
	}
}

func TestLogStore_DeleteAuthorContent_RetryConvergesWithoutStrippingTheTombstone(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	author := newAuthorityKey(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)

	if _, err := store.Append(ctx, syncID, synclog.NamespaceContent, syncID+"-a1", []byte("caption"), 1, token, author.publicKeyHex); err != nil {
		t.Fatal(err)
	}

	first, err := store.DeleteAuthorContent(ctx, authorContentDeletion(author, syncID, syncID+"-tomb", token))
	if err != nil {
		t.Fatal(err)
	}
	// The tombstone is authored by the same key — a retry must not treat
	// it as content to strip (it's meta, outside the range paged here,
	// regardless).
	second, err := store.DeleteAuthorContent(ctx, authorContentDeletion(author, syncID, syncID+"-tomb", token))
	if err != nil {
		t.Fatalf("a retry must converge rather than fail: %v", err)
	}
	if second.CommitResult != first.CommitResult {
		t.Fatalf("expected the retry to return the original commit, got %+v then %+v", first.CommitResult, second.CommitResult)
	}
	// Deliberately still returned, not empty: a retry re-reports every
	// authored entryId regardless of whether it was already stripped, so
	// the caller's blob cleanup gets another chance if an earlier attempt
	// stripped content but then failed appending its tombstone.
	if len(second.StrippedEntryIDs) != 1 {
		t.Fatalf("expected the retry to still report the stripped entry for blob cleanup, got %v", second.StrippedEntryIDs)
	}

	read, err := store.Read(ctx, syncID, synclog.NamespaceContent, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(read.Entries) != 1 || len(read.Entries[0].EncryptedMeta) != 0 {
		t.Fatalf("expected just the stripped content row, got %d entries", len(read.Entries))
	}

	meta, err := store.Read(ctx, syncID, synclog.NamespaceMeta, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(meta.Entries) != 1 || len(meta.Entries[0].EncryptedMeta) == 0 {
		t.Fatal("expected the tombstone's ciphertext intact after the retry, in meta")
	}
}

func TestLogStore_DeleteAuthorContent_UnknownCircleIsNotFound(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	author := newAuthorityKey(t)

	if _, err := store.DeleteAuthorContent(ctx, authorContentDeletion(author, testsupport.UniqueSyncID(t), "", "")); !errors.Is(err, synclog.ErrCircleNotFound) {
		t.Fatalf("expected ErrCircleNotFound, got %v", err)
	}
}

func TestLogStore_DeleteAuthorContent_StaleTokenFailsBeforeAnythingIsStripped(t *testing.T) {
	ctx := context.Background()
	store := testsupport.NewLogStore(t)
	syncID := testsupport.UniqueSyncID(t)
	founder := newAuthorityKey(t)
	author := newAuthorityKey(t)
	token := newToken(t)
	bootstrap(t, store, syncID, founder, token)

	if _, err := store.Append(ctx, syncID, synclog.NamespaceContent, syncID+"-a1", []byte("caption"), 1, token, author.publicKeyHex); err != nil {
		t.Fatal(err)
	}

	if _, err := store.DeleteAuthorContent(ctx, authorContentDeletion(author, syncID, syncID+"-tomb", newToken(t))); !errors.Is(err, synclog.ErrWriteTokenMismatch) {
		t.Fatalf("expected ErrWriteTokenMismatch, got %v", err)
	}

	read, err := store.Read(ctx, syncID, synclog.NamespaceContent, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(read.Entries[0].EncryptedMeta) == 0 {
		t.Fatal("expected nothing stripped under a stale token")
	}
}
