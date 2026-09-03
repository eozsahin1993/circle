// Package createlog is the whole vertical slice for POST /circles/{syncId}
// — see logstore.Store.Bootstrap. The one call not gated by a write token
// or authority signature: nobody can present either for a circle that
// doesn't exist yet. Protected against claiming an in-use syncId by
// Bootstrap's own attribute_not_exists condition, and against
// unauthenticated spam by the same RequireSession wrapping every
// /circles/ route.
package createlog

import (
	"context"

	"circle-relay/internal/storage/logstore"
)

type Service struct {
	LogStore logstore.Store
}

func (s *Service) Bootstrap(ctx context.Context, syncID, founderAuthorityPublicKey, initialWriteTokenHash string) error {
	return s.LogStore.Bootstrap(ctx, syncID, founderAuthorityPublicKey, initialWriteTokenHash)
}
