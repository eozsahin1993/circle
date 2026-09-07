// Package getepochs is the whole vertical slice for GET /epochs — a cheap,
// batched "has anything changed" check across many circles at once, for a
// client polling far more often than it would ever call getlog's real Read.
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
