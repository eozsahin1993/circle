// Package logstore defines the interface domain logic depends on for the
// append-only per-circle log — implementations live in subpackages, one
// per backing technology (see logstore/dynamodb).
//
// The log is permanent and never mutated, split into two namespaces —
// meta (identities, keys, roles; rare, always synced in full) and
// content (posts, comments; voluminous, paged) — gated by two
// relay-enforced capabilities. A write token
// (derived from the circle's current content key) proves "a current
// member," required for every append. An authority signature proves "an
// admin," required on top of it for the two discretionary fields of
// control state: the write token (Rotate) and the authority set itself
// (ChangeAuthority). Everything else about an entry — type, author — is
// opaque to the relay; only clients decrypt and verify that.
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

// AuthorityAction is which way ChangeAuthority moves a key across the
// circle's authority set.
type AuthorityAction string

const (
	AuthorityAdd    AuthorityAction = "add"
	AuthorityRemove AuthorityAction = "remove"
)

func (a AuthorityAction) Valid() bool {
	return a == AuthorityAdd || a == AuthorityRemove
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
	// shouldn't try to: the relay enforces possession of a capability,
	// never identity, so it has no way to distinguish them anyway.
	ErrWriteTokenMismatch = errors.New("logstore: write token does not match current control state")
	// ErrAuthorityNotRecognized: authorityPublicKey isn't in the circle's current authority set.
	ErrAuthorityNotRecognized = errors.New("logstore: authority key not recognized for this circle")
	// ErrInvalidAuthorityAction: action wasn't AuthorityAdd or AuthorityRemove.
	ErrInvalidAuthorityAction = errors.New("logstore: invalid authority action")
	// ErrInvalidAuthorityKey: the key ChangeAuthority was asked to add or
	// remove isn't a hex-encoded ed25519 public key. Checked because a
	// malformed key added to the set can only ever be removed by someone
	// else — nothing can sign as it.
	ErrInvalidAuthorityKey = errors.New("logstore: authority key is not a hex-encoded ed25519 public key")
	// ErrWouldEmptyAuthoritySet: a ChangeAuthority remove would take the
	// last key out. Nobody could then rotate, promote or demote again —
	// the circle's governance would be permanently stuck.
	ErrWouldEmptyAuthoritySet = errors.New("logstore: removing that key would leave the authority set empty")
	// ErrInvalidSignature: checked before any storage call, so this never reflects a race, only a bad request.
	ErrInvalidSignature = errors.New("logstore: signature does not verify")
	// ErrCircleDeleted: the circle has been deleted, so it takes no
	// further writes. Reads still work — that's how a device that hasn't
	// synced yet finds the tombstone saying so.
	ErrCircleDeleted = errors.New("logstore: circle has been deleted")
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
// every version it holds.
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

// Epochs is one circle's latest epoch per namespace — see Peek.
type Epochs struct {
	Meta    int64
	Content int64
}

// AuthorityChange is one promotion or demotion, whole — the capabilities
// it's checked against, the set mutation it makes, and the meta entry
// recording it.
type AuthorityChange struct {
	SyncID           string
	EntryID          string
	EncryptedPayload []byte
	// KeyVersion: nothing rotates here, so unlike Rotate there's no
	// pre/post distinction.
	KeyVersion               int64
	WriteToken               string
	Action                   AuthorityAction
	TargetAuthorityPublicKey string
	SignerAuthorityPublicKey string
	Signature                []byte
}

// Message is the exact byte sequence Signature must cover — same
// version-prefixed, null-byte-joined construction as RotateMessage, and
// bound to every part of what it authorizes: the circle, the action (so a
// promotion's signature can't be replayed as the demotion of the same
// person), the target key, and the entry (so one signature moves the set
// exactly once).
//
// Both the relay and every client must construct this identically.
func (c AuthorityChange) Message() []byte {
	return []byte("circle-relay/authority-change/v1\x00" + string(c.Action) + "\x00" + c.SyncID + "\x00" + c.EntryID + "\x00" + c.TargetAuthorityPublicKey)
}

// CircleDeletion is one circle being deleted — the tombstone entry
// recording it, and the capabilities it's checked against.
type CircleDeletion struct {
	SyncID           string
	EntryID          string
	EncryptedPayload []byte
	KeyVersion       int64
	WriteToken       string

	SignerAuthorityPublicKey string
	Signature                []byte
}

func (d CircleDeletion) Message() []byte {
	return []byte("circle-relay/delete-circle/v1\x00" + d.SyncID + "\x00" + d.EntryID)
}

// Store is storage for the append-only per-circle log, plus the small
// piece of relay-visible control state — the authority set, write-token
// hash, and per-namespace counters, held in one `#control` item per
// circle — that authorizes writes to it. Bootstrap, Append, Rotate and
// ChangeAuthority are each expected to use the backend's real transaction
// primitive for atomicity (DynamoDB: TransactWriteItems + a
// compare-and-swap read) rather than composing smaller calls and hoping
// nothing races.
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

	// ChangeAuthority is the capability-gated write path for a promotion or
	// demotion — always a meta-namespace entry. Atomically: verifies
	// WriteToken, verifies SignerAuthorityPublicKey is in the authority
	// set, appends the entry, and adds or removes
	// TargetAuthorityPublicKey — all or none. Both halves commit together
	// because the circle keeps two records of who governs it, the set and
	// the log, and nothing repairs a disagreement between them from the
	// log alone.
	//
	// Signature must verify against SignerAuthorityPublicKey for the
	// change's Message() — checked before any storage call, so a forged
	// signature never touches control state. Authority only ever comes
	// from authority: nothing seeds the set but a key already in it.
	//
	// A signer may remove their own key — that's how leaving hands back
	// authority — but never the last one (ErrWouldEmptyAuthoritySet):
	// DynamoDB drops a string set attribute once its last element goes,
	// leaving nothing to add a key back to.
	ChangeAuthority(ctx context.Context, change AuthorityChange) (CommitResult, error)

	// DeleteCircle ends a circle: appends the tombstone and stamps
	// deletedAt on control state in one transaction, then deletes every
	// content-namespace entry.
	//
	// Meta survives, tombstone included. Handlers resolve an entry's author
	// against the roster, and the roster is built from meta — sweep it and
	// a device syncing from epoch 0 has nothing to verify the tombstone
	// against, skips it, and keeps a circle that no longer exists.
	//
	// Only the tombstone-and-stamp is atomic; the sweep behind it is
	// resumable instead, since it can delete far more items than one
	// transaction holds. The ordering is the point: a tombstone with
	// entries still under it is a retry, entries with no tombstone are
	// silent data loss.
	DeleteCircle(ctx context.Context, deletion CircleDeletion) (CommitResult, error)

	// Read never deletes or evicts — retention is permanent (invariant 1).
	Read(ctx context.Context, syncID string, ns Namespace, since int64) (FetchResult, error)

	// Peek is the cheap half of Read — the same control-state check Read
	// itself starts with, without the entries Query that follows it. Meant
	// for a client that just wants to know whether a real Read is worth
	// making, polled far more often than Read itself. A syncID with no
	// control state is simply absent from the result map, not an error —
	// one bad/stale id in a multi-circle batch shouldn't fail the rest.
	Peek(ctx context.Context, syncIDs []string) (map[string]Epochs, error)

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

// DeleteBlobMessage is the exact byte sequence an authority signature
// must cover to delete a blob the admin did not upload themselves. Same
// construction as the two above, bound to the entry so one signature
// destroys one object rather than any blob in the circle.
func DeleteBlobMessage(syncID, entryID string) []byte {
	return []byte("circle-relay/delete-blob/v1\x00" + syncID + "\x00" + entryID)
}
