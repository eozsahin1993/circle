// Package changeauthority is the whole vertical slice for POST
// /circles/{syncId}/authority — see logstore.Store.ChangeAuthority. The
// only way a circle's authority set ever changes after Bootstrap, and the
// second of the two write paths gated by both capabilities at once: the
// write token (proving current membership) and an authority signature
// (proving the signer is already an authority), atomically alongside
// appending the role_change entry that records the change.
package changeauthority

import (
	"context"

	"circle-relay/internal/storage/logstore"
)

type Service struct {
	LogStore logstore.Store
}

func (s *Service) ChangeAuthority(ctx context.Context, change logstore.AuthorityChange) (logstore.CommitResult, error) {
	return s.LogStore.ChangeAuthority(ctx, change)
}
