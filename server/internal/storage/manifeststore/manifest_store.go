// Package manifeststore defines the interface domain logic depends on for
// the per-account encrypted circle-membership manifest — implementations
// live in subpackages, one per backing technology (see
// manifeststore/dynamodb). The relay never sees plaintext here: the blob
// is ciphertext the client encrypted under a key derived from its own
// master seed, so only the account's own device(s) can read it — see
// server/DESIGN.md's "Account recovery" section.
package manifeststore

import "context"

// Store persists one opaque blob per account, keyed by the account
// identifier auth.RequireSession resolves — never TTL'd, kept until the
// account itself is deleted.
type Store interface {
	// GetManifest returns nil, nil if this account has never stored one.
	GetManifest(ctx context.Context, accountID string) ([]byte, error)
	// PutManifest overwrites the account's manifest in place — the client
	// always sends its full current blob, there's no partial update.
	PutManifest(ctx context.Context, accountID string, blob []byte) error
}
