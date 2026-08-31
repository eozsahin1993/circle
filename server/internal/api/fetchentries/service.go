// Package fetchentries is the whole vertical slice for GET
// /circles/{circleLogId}/entries.
package fetchentries

import (
	"context"

	"circle-relay/internal/ports"
)

type Service struct {
	LogStore ports.LogStore
}

func (s *Service) Fetch(ctx context.Context, circleLogID string, since int64) (ports.FetchSinceResult, error) {
	return s.LogStore.Read(ctx, circleLogID, since)
}
