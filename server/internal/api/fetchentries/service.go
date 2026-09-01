// Package fetchentries is the whole vertical slice for GET
// /circles/{circleLogId}/entries.
package fetchentries

import (
	"context"

	"circle-relay/internal/storage/logstore"
)

type Service struct {
	LogStore logstore.Store
}

func (s *Service) Fetch(ctx context.Context, circleLogID string, since int64) (logstore.FetchSinceResult, error) {
	return s.LogStore.Read(ctx, circleLogID, since)
}
