// Package logstore defines the interface domain logic depends on for the
// append-only per-circle log — implementations live in subpackages, one
// per backing technology (see logstore/dynamodb).
//
// See server/SYNC_DESIGN.md for the design: a permanent, never-mutated
// log split into two namespaces — meta (identities, keys, roles; rare,
// always synced in full) and content (posts, comments; voluminous,
// paged) — gated by two relay-enforced capabilities. A write token
// (derived from the circle's current content key) proves "a current
// member," required for every append. An authority signature proves "an
// admin," required only for rotating the write token. Everything else
// about an entry — type, author — is opaque to the relay; only clients
// decrypt and verify that.
package logstore

import (
	"context"
	"errors"
)

// Namespace selects which of a circle's two independent, permanently
// separate append sequences an operation targets. See the package doc for
// what each is for.
type Namespace string

const (
	NamespaceMeta    Namespace = "meta"
	NamespaceContent Namespace = "content"
)

func (ns Namespace) Valid() bool {
	return ns == NamespaceMeta || ns == NamespaceContent
}

// Sentinel errors a Store implementation returns so the API layer can map
// them to the right HTTP status without knowing anything backend-specific.
var (
	// ErrAlreadyExists: Bootstrap called for a syncID that already has control state.
	ErrAlreadyExists = errors.New("logstore: syncID already exists")
	// ErrCircleNotFound: syncID has no control state. Distinct from
	// ErrWriteTokenMismatch — a syncID's existence isn't sensitive, so
	// there's no blindness reason to conflate "no such circle" with
	// "wrong token".
	ErrCircleNotFound = errors.New("logstore: no control state for this syncID")
	// ErrInvalidNamespace: ns wasn't NamespaceMeta or NamespaceContent.
	ErrInvalidNamespace = errors.New("logstore: invalid namespace")
	// ErrWriteTokenMismatch: the presented write token doesn't hash to
	// what's on file — either stale (a rotation the caller hasn't synced
	// past) or never a member. The API can't tell these apart and
	// shouldn't try to — see server/SYNC_DESIGN.md's "possession, not
	// identity" principle.
	ErrWriteTokenMismatch = errors.New("logstore: write token does not match current control state")
	// ErrAuthorityNotRecognized: authorityPublicKey isn't in the circle's current authority set.
	ErrAuthorityNotRecognized = errors.New("logstore: authority key not recognized for this circle")
	// ErrInvalidSignature: checked before any storage call, so this never reflects a race, only a bad request.
	ErrInvalidSignature = errors.New("logstore: signature does not verify")
	// ErrConcurrentModification: a Rotate lost its compare-and-swap race
	// past the retry budget. Expected to be vanishingly rare at
	// family-circle scale — treat as "retry," not a hard failure.
	ErrConcurrentModification = errors.New("logstore: control state changed concurrently, exceeded retry budget")
)

// LogEntry is one entry in a circle's append-only log — never decrypted
// content. EncryptedMeta is opaque ciphertext; the relay never looks
// inside it (not even for its entry type — see the package doc).
// KeyVersion is plaintext, not opaque: a reader needs it to pick the
// right content key by direct lookup instead of trial-decrypting with
// every version it holds — see server/SYNC_DESIGN.md's entry shape.
type LogEntry struct {
	Epoch         int64
	KeyVersion    int64
	EncryptedMeta []byte
	ReceivedAt    int64
}

// CommitResult is what a successful (or idempotently-retried) write hands
// back — the epoch/receivedAt that ended up canonical for entryID.
type CommitResult struct {
	Epoch      int64
	ReceivedAt int64
}

// FetchResult is one page of a namespace's entries, oldest first.
type FetchResult struct {
	// Entries strictly after Since, capped at the store's page size — a
	// caller must call again with Since advanced to the last entry it
	// received (never to CurrentEpoch — a capped page means CurrentEpoch
	// is still ahead of what was actually returned).
	Entries []LogEntry
	// CurrentEpoch is this namespace's true latest epoch. Never ahead of
	// Entries due to eviction (nothing is ever evicted — invariant 1),
	// only due to page-size capping.
	CurrentEpoch int64
}

// Store is storage for the append-only per-circle log, plus the small
// piece of relay-visible control state (see server/SYNC_DESIGN.md's
// "#control") that authorizes writes to it. Bootstrap/Append/Rotate are
// each expected to use the backend's real transaction primitive for
// atomicity (DynamoDB: TransactWriteItems + a compare-and-swap read)
// rather than composing smaller calls and hoping nothing races.
type Store interface {
	// Bootstrap creates syncID's control state: founderAuthorityPublicKey
	// as the sole initial authority-set member, initialWriteTokenHash as
	// what future Append calls must match. Fails with ErrAlreadyExists if
	// syncID already has control state.
	Bootstrap(ctx context.Context, syncID, founderAuthorityPublicKey, initialWriteTokenHash string) error

	// Append is the possession-gated write path shared by every ordinary
	// entry in either namespace. writeToken is the raw (not pre-hashed)
	// token — Append hashes it and compares against what's on file.
	//
	// entryID makes retries safe: an entryID already recorded for this
	// (syncID, ns) returns the *original* CommitResult rather than
	// creating a second entry. keyVersion is recorded as plaintext
	// alongside the entry (see LogEntry) — the caller's responsibility to
	// get right; the relay stores it as-is and never verifies it (it
	// can't — the content is opaque).
	Append(ctx context.Context, syncID string, ns Namespace, entryID string, encryptedPayload []byte, keyVersion int64, writeToken string) (CommitResult, error)

	// Rotate is the capability-gated write path for a key rotation —
	// always a meta-namespace entry. Atomically: verifies
	// currentWriteToken, verifies authorityPublicKey is in the authority
	// set, appends the entry, and swaps in newWriteTokenHash — all or
	// none.
	//
	// signature must verify against authorityPublicKey for
	// RotateMessage(syncID, entryID, newWriteTokenHash) — checked before
	// any storage call, so a forged signature never touches control
	// state. currentKeyVersion is the *pre*-rotation version: the
	// key_rotation entry itself is encrypted under the key being rotated
	// away from, not the new one.
	Rotate(ctx context.Context, syncID, entryID string, encryptedPayload []byte, currentKeyVersion int64, currentWriteToken, newWriteTokenHash, authorityPublicKey string, signature []byte) (CommitResult, error)

	// Read never deletes or evicts — retention is permanent (invariant 1).
	Read(ctx context.Context, syncID string, ns Namespace, since int64) (FetchResult, error)

	// VerifyWriteToken checks writeToken against what's on file, without
	// mutating anything — exposed standalone for operations that need to
	// gate on "a current member" without appending. See getuploadtarget:
	// obtaining a blob upload URL is a write capability despite not
	// mutating anything server-side, so it's gated the same way Append is.
	VerifyWriteToken(ctx context.Context, syncID, writeToken string) error

	// VerifyAuthoritySignature checks signature's cryptographic validity
	// for message against authorityPublicKey, then confirms
	// authorityPublicKey is a member of syncID's current authority set —
	// without mutating anything. The authority-plane analog of
	// VerifyWriteToken: for an operation that needs to gate on "an admin"
	// rather than just "a current member," without appending or rotating.
	// See getcoverphotouploadtarget: obtaining a cover-photo upload URL
	// requires proving admin status, since the object it points at has no
	// per-upload existence check to fall back on (see
	// blobstore.Store.GetCoverPhotoUploadTarget).
	VerifyAuthoritySignature(ctx context.Context, syncID, authorityPublicKey string, message []byte, signature []byte) error
}

// RotateMessage is the exact byte sequence an authority signature must
// cover for a Rotate call — version-prefixed and null-byte-joined (not
// concatenated directly) so no combination of field values can be
// reinterpreted as a different message, e.g. syncID="ab"+entryID="c"
// can't collide with syncID="a"+entryID="bc". Bound to newWriteTokenHash
// so it's meaningless for any rotation but this exact one.
//
// Both the relay and every client must construct this identically.
func RotateMessage(syncID, entryID, newWriteTokenHash string) []byte {
	return []byte("circle-relay/rotate/v1\x00" + syncID + "\x00" + entryID + "\x00" + newWriteTokenHash)
}

// CoverPhotoUploadMessage is the exact byte sequence an authority
// signature must cover to obtain a cover-photo upload URL — see
// getcoverphotouploadtarget. Same version-prefixed, null-byte-joined
// construction as RotateMessage, and for the same reason: it's what makes
// the signature mean "I am authorizing a cover-photo upload for this
// circle" specifically, not reinterpretable as authorization for anything
// else this same admin key might sign.
func CoverPhotoUploadMessage(syncID string) []byte {
	return []byte("circle-relay/cover-photo-upload/v1\x00" + syncID)
}
