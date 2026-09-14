// Package manifeststore defines the interface domain logic depends on for
// the per-account encrypted circle-membership manifest — implementations
// live in subpackages, one per backing technology (see
// manifeststore/dynamodb). The relay never sees plaintext here: the blob
// is ciphertext the client encrypted under a key derived from its own
// master seed, so only the account's own device(s) can read it.
//
// Superseded, not yet migrated: this one-blob-per-account shape is due
// to be replaced by a row per membership under a seed-derived (not
// account-keyed) partition — fixes a real bug (this manifest's
// circleIds can't actually locate anything today, since reaching a log
// also needs the circle secret, which lives only in Keychain and dies
// with the device) and removes the last account-keyed storage in the
// system. Untouched by the sync-log redesign; still the live
// implementation until that migration happens.
package manifeststore

import (
	"context"
	"errors"
)

// ErrVersionMismatch means the stored manifest moved between the caller's
// read and its write — another of the account's devices got there first.
// The caller must re-read, reapply its change to the newer blob, and retry;
// writing regardless would silently drop whatever that device recorded,
// and since the blob carries circle content keys, a lost write can cost
// access to a circle.
var ErrVersionMismatch = errors.New("manifeststore: manifest changed concurrently")

// Manifest is the stored blob and the version to quote back when writing.
// The zero value is what an account that has never stored one reads as.
type Manifest struct {
	Blob []byte
	// Version is 0 both for "never stored" and for a row written before
	// versioning existed — see the store implementation for why those two
	// have to be indistinguishable to callers.
	Version int64
}

// Store persists one opaque blob per account, keyed by the account
// identifier auth.RequireSession resolves — never TTL'd, kept until the
// account itself is deleted.
type Store interface {
	// GetManifest returns the zero Manifest if this account has never stored one.
	GetManifest(ctx context.Context, accountID string) (Manifest, error)
	// PutManifest replaces the account's manifest — the client always sends
	// its full current blob, there's no partial update. expectedVersion is
	// the Version from the read this blob was built on; the write only lands
	// if the stored manifest is still at that version, and returns
	// ErrVersionMismatch otherwise.
	PutManifest(ctx context.Context, accountID string, blob []byte, expectedVersion int64) error
}
