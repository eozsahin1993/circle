// Package manifest is the vertical slice for GET/PUT /account/manifest —
// the account's encrypted circle-membership index, see server/DESIGN.md's
// "Account recovery" section. The relay only ever stores and returns
// ciphertext; nothing here looks inside it.
package manifest

import (
	"context"

	"circle-relay/internal/storage/manifeststore"
)

type Service struct {
	ManifestStore manifeststore.Store
}

// Get returns nil, nil if accountID has never stored a manifest.
func (s *Service) Get(ctx context.Context, accountID string) ([]byte, error) {
	return s.ManifestStore.GetManifest(ctx, accountID)
}

// Put overwrites accountID's manifest in place.
func (s *Service) Put(ctx context.Context, accountID string, blob []byte) error {
	return s.ManifestStore.PutManifest(ctx, accountID, blob)
}
