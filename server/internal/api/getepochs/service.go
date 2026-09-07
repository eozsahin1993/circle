// Package getepochs is the whole vertical slice for POST /epochs/peek — a
// cheap, batched "has anything changed" check across many circles at once,
// for a client polling far more often than it would ever call getlog's
// real Read. POST despite mutating nothing, and named `peek` after the
// store operation it wraps rather than as a plain resource: the syncIds
// belong in the body, not a logged query string — see handler.go's
// request type.
package getepochs

import (
	"context"

	"circle-relay/internal/storage/logstore"
)

type Service struct {
	LogStore logstore.Store
}

func (s *Service) Peek(ctx context.Context, syncIDs []string) (map[string]logstore.Epochs, error) {
	return s.LogStore.Peek(ctx, syncIDs)
}
