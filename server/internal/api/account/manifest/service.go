// Package manifest is the vertical slice for GET/PUT /account/manifest —
// the account's encrypted circle-membership index, so a device recovering
// from just the seed phrase knows which circles to reconstruct. The relay
// only ever stores and returns ciphertext; nothing here looks inside it.
//
// See manifeststore's package doc: this endpoint's one-blob-per-account
// storage shape is being replaced by a row-per-membership scheme under a
// seed-derived partition, which avoids the read-modify-write race two of
// the same account's devices can hit today (not yet migrated).
package manifest

import (
	"context"

	"circle-relay/internal/storage/manifeststore"
)

type Service struct {
	ManifestStore manifeststore.Store
}

// Get returns the zero Manifest if accountID has never stored one.
func (s *Service) Get(ctx context.Context, accountID string) (manifeststore.Manifest, error) {
	return s.ManifestStore.GetManifest(ctx, accountID)
}

// Put replaces accountID's manifest, only if it's still at expectedVersion —
// returns manifeststore.ErrVersionMismatch if another device wrote first.
func (s *Service) Put(ctx context.Context, accountID string, blob []byte, expectedVersion int64) error {
	return s.ManifestStore.PutManifest(ctx, accountID, blob, expectedVersion)
}
